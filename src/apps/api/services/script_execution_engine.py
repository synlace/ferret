import asyncio
import logging
import json
import re
import os
import uuid
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List, Dict

from models import Run
import deps

_log = logging.getLogger(__name__)


def _extract_domain(target_url: str) -> str:
    """Strip wildcard prefix, scheme, and path from a target URL to get the base domain."""
    s = target_url.strip()
    # Strip wildcard
    s = re.sub(r"^\*\.", "", s)
    # Strip scheme
    s = re.sub(r"^https?://", "", s)
    # Strip path and query
    s = s.split("/")[0].split("?")[0].split("#")[0]
    return s


def _container_workspace_path(project_id: str, workspace_id: str) -> str:
    """Return the workspace path as seen from inside the sandbox container."""
    import os
    container_base = os.getenv(
        "FERRET_CONTAINER_WORKSPACES_DIR",
        str(deps.WORKSPACES_DIR),
    )
    return f"{container_base}/{project_id}/{workspace_id}"


class ScriptExecutionEngine:
    """Service to coordinate background script execution, process logging,
    cancellation, process registry, and manifest processing.
    """

    def __init__(self, db_client=None):
        self._db_client = db_client
        # Concurrency limit semaphore
        max_concurrent = int(os.getenv("FERRET_MAX_CONCURRENT_RUNS", "5"))
        self._execution_semaphore = asyncio.Semaphore(max_concurrent)
        # Semaphore to limit concurrent manifest processing database writes
        self._manifest_semaphore = asyncio.Semaphore(5)
        # run_id -> list of asyncio.Queue[str | None]
        self._live_queues: Dict[str, List[asyncio.Queue]] = {}
        # run_id -> asyncio.Event
        self._cancel_events: Dict[str, asyncio.Event] = {}
        self._scheduled_run_ids = set()
        self._startup_time = time.time()

    @property
    def db_client(self):
        return self._db_client or deps.db_client

    def register_listener_queue(self, run_id: str, q: asyncio.Queue) -> None:
        """Register a queue to receive real-time execution outputs."""
        self._live_queues.setdefault(run_id, []).append(q)

    def unregister_listener_queue(self, run_id: str, q: asyncio.Queue) -> None:
        """Unregister a real-time output queue."""
        listeners = self._live_queues.get(run_id, [])
        if q in listeners:
            listeners.remove(q)
        if not listeners:
            self._live_queues.pop(run_id, None)

    def cancel_run(self, run_id: str) -> bool:
        """Request cancellation of an active run."""
        event = self._cancel_events.get(run_id)
        if event:
            event.set()
            return True
        return False

    def is_run_cancellable(self, run_id: str) -> bool:
        """Check if the run has an active cancel event (and is thus running)."""
        return run_id in self._cancel_events

    def _broadcast(self, run_id: str, line: Optional[str]) -> None:
        """Push a line (or None sentinel) to all active queues for a run."""
        for q in list(self._live_queues.get(run_id, [])):
            try:
                q.put_nowait(line)
            except asyncio.QueueFull:
                pass

    async def execute_run_in_background(
        self,
        run_id: str,
        workspace_id: str,
        project_id: str,
        plan: dict,
        target_url: str,
        follow_on_plan_ids: Optional[List[str]] = None,
        follow_on_path_plan_ids: Optional[List[str]] = None,
    ) -> None:
        self._scheduled_run_ids.add(run_id)
        try:
            async with self._execution_semaphore:
                await self._execute_run_in_background_raw(
                    run_id=run_id,
                    workspace_id=workspace_id,
                    project_id=project_id,
                    plan=plan,
                    target_url=target_url,
                    follow_on_plan_ids=follow_on_plan_ids,
                    follow_on_path_plan_ids=follow_on_path_plan_ids,
                )
        finally:
            self._scheduled_run_ids.discard(run_id)

    async def _execute_run_in_background_raw(
        self,
        run_id: str,
        workspace_id: str,
        project_id: str,
        plan: dict,
        target_url: str,
        follow_on_plan_ids: Optional[List[str]] = None,
        follow_on_path_plan_ids: Optional[List[str]] = None,
    ) -> None:
        """Background orchestration of script execution, template substitutions, logging, 
        and real-time streaming manifest parsing.
        """
        from routers.chats_runners import stream_run_script
        from routers.plans import _find_plan

        try:
            cancel_event = asyncio.Event()
            self._cancel_events[run_id] = cancel_event

            # Resolve targeted Den ID for this run first
            run_record = await self.db_client.get_run(run_id)
            target_den_id = run_record.get("den_id", "local") if run_record else "local"

            # If targeting a non-local Fargate Den, the script execution engine should NOT
            # run the job locally. Instead, it should wait for the polling cloud runner
            # to fetch it.
            if target_den_id != "local":
                _log.info("Run %s: targeting AWS Fargate Den '%s' — bypassing local scheduling execution flow.", run_id, target_den_id)
                return

            # Deduplicate workspaces from existing children
            existing_children = await self.db_client.get_workspaces(project_id)
            seen_workspaces: Dict[str, str] = {
                ws["name"]: ws["id"]
                for ws in existing_children
                if ws.get("parent_id") == workspace_id
            }
            if seen_workspaces:
                _log.info(
                    "run %s: pre-seeded seen_workspaces with %d existing children",
                    run_id, len(seen_workspaces),
                )

            # Mark run as running
            await self.db_client.update_run_status(
                run_id,
                status="running",
                started_at=datetime.now(timezone.utc),
            )

            # Resolve paths
            ws_root = deps.WORKSPACES_DIR / project_id / workspace_id
            log_filename = f"run_{run_id[:8]}.log"
            log_dir = ws_root / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            log_path = log_dir / log_filename
            run_log_rel = f"logs/{log_filename}"

            await self.db_client.update_run_status(run_id, status="running", run_log_path=run_log_rel)

            domain = _extract_domain(target_url)
            container_ws = _container_workspace_path(project_id, workspace_id)

            # Substitutions
            script = plan.get("prompt", "")
            script = script.replace("{{target}}", target_url)
            script = script.replace("{{domain}}", domain)
            script = script.replace("{{workspace}}", container_ws)
            script = script.replace("{{workspace_id}}", workspace_id)
            script = script.replace("{{session_id}}", run_id)
            script = script.replace("{{project_id}}", project_id)
            
            _first_follow_on = (follow_on_plan_ids or [""])[0]
            script = script.replace("{{follow_on_plan}}", _first_follow_on)

            interpreter = plan.get("interpreter", "bash")
            timeout_sec = int(plan.get("max_runtime_seconds", 600))

            fn_args = {
                "interpreter": interpreter,
                "script": script,
                "timeout": timeout_sec,
                "name": f"run_{run_id[:8]}",
            }

            exit_code = 0

            # Load-balance sandbox executor across active runners if any are registered
            active_runners = await self.db_client.get_active_runners(timeout_seconds=30)
            runner_executor = deps.sandbox_executor
            
            # Filter active runners to only select local ones (non-fargate) when running locally
            local_runners = [r for r in active_runners if "runner-fargate-" not in r["id"]]
            if local_runners:
                import random
                chosen_runner = random.choice(local_runners)
                _log.info("Run %s: scheduling execution on local runner %s", run_id, chosen_runner["id"])
                runner_executor = deps.sandbox_executor.with_container(chosen_runner["id"])
            else:
                _log.info("Run %s: no active local runners registered — using default sandbox container %s", run_id, deps.sandbox_executor.container_name)

            with log_path.open("w", encoding="utf-8") as log_fh:
                streamer = stream_run_script(fn_args, project_id=project_id, session_id=run_id, executor=runner_executor)
                async for chunk, is_final, final_result in streamer:
                    if cancel_event.is_set():
                        cancelled_msg = "\r\n[FERRET] Run cancelled by user.\r\n"
                        log_fh.write(cancelled_msg)
                        log_fh.flush()
                        self._broadcast(run_id, cancelled_msg)
                        exit_code = -1
                        break

                    if not is_final and chunk:
                        log_fh.write(chunk)
                        log_fh.flush()
                        
                        for line in chunk.splitlines(keepends=True):
                            self._broadcast(run_id, line)
                            stripped = line.strip()
                            if stripped.startswith("[FERRET:MANIFEST]"):
                                payload_str = stripped[len("[FERRET:MANIFEST]"):].strip()
                                try:
                                    ws_spec = json.loads(payload_str)
                                except Exception as json_err:
                                    _log.warning("run %s: malformed [FERRET:MANIFEST] line: %s, err: %s", run_id, stripped, json_err)
                                    continue

                                ws_name = ws_spec.get("name", "").strip()
                                if not ws_name:
                                    continue

                                if ws_name in seen_workspaces:
                                    existing_ws_id = seen_workspaces[ws_name]
                                    for rel_path, content in ws_spec.get("files", {}).items():
                                        try:
                                            target = deps.WORKSPACES_DIR / project_id / existing_ws_id / rel_path
                                            target.parent.mkdir(parents=True, exist_ok=True)
                                            target.write_text(str(content), encoding="utf-8")
                                        except Exception as fe:
                                            _log.warning("run %s: file update error: %s", run_id, fe)
                                else:
                                    entry_type = ws_spec.get("type", "host")
                                    entry_follow_on = (
                                        follow_on_path_plan_ids if entry_type == "path" else follow_on_plan_ids
                                    ) or []
                                    asyncio.create_task(
                                        self._process_manifest_entry(
                                            ws_spec=ws_spec,
                                            parent_workspace_id=workspace_id,
                                            project_id=project_id,
                                            follow_on_plan_ids=entry_follow_on,
                                            seen_workspaces=seen_workspaces,
                                            den_id=target_den_id,
                                        )
                                    )

                    if is_final and final_result:
                        meta_idx = final_result.rfind("\n__META__:")
                        if meta_idx != -1:
                            try:
                                meta = json.loads(final_result[meta_idx + len("\n__META__:"):])
                                exit_code = meta.get("exit_code", 0) or 0
                            except Exception:
                                pass
                        
                        promotion_marker = "\r\n[FERRET] ✓"
                        remainder = final_result[:meta_idx] if meta_idx != -1 else final_result
                        promo_idx = remainder.find(promotion_marker)
                        if promo_idx != -1:
                            promotion_only = remainder[promo_idx:]
                            log_fh.write(promotion_only)
                            for line in promotion_only.splitlines(keepends=True):
                                self._broadcast(run_id, line)

            if exit_code == 0:
                await self._process_manifest(ws_root, workspace_id, project_id, seen_workspaces=seen_workspaces, den_id=target_den_id)

                # Parse HTTP status code from whatweb_raw.json if it exists and update the workspace
                whatweb_json = ws_root / "notes" / "whatweb_raw.json"
                if whatweb_json.exists():
                    try:
                        with open(whatweb_json) as f:
                            for line in f:
                                line = line.strip()
                                if not line:
                                    continue
                                try:
                                    entry = json.loads(line)
                                    status_code = None
                                    if isinstance(entry, list) and len(entry) >= 2:
                                        status_code = entry[1].get("http_status")
                                    elif isinstance(entry, dict):
                                        status_code = entry.get("http_status")
                                    if status_code:
                                        await self.db_client.update_workspace_http_status(workspace_id, int(status_code))
                                        break
                                except Exception:
                                    pass
                    except Exception as e:
                        _log.warning("Failed to parse whatweb_raw.json for workspace %s: %s", workspace_id, e)

            status = "done" if exit_code == 0 else "error"
            await self.db_client.update_run_status(
                run_id,
                status=status,
                exit_code=exit_code,
                run_log_path=run_log_rel,
                finished_at=datetime.now(timezone.utc),
            )
            _log.info("run completed id=%s status=%s exit_code=%d", run_id, status, exit_code)

            self._broadcast(run_id, None)  # sentinel
            self._live_queues.pop(run_id, None)
            self._cancel_events.pop(run_id, None)

        except Exception as exc:
            _log.error("run failed id=%s: %s", run_id, exc, exc_info=True)
            try:
                await self.db_client.update_run_status(
                    run_id,
                    status="error",
                    finished_at=datetime.now(timezone.utc),
                )
            except Exception:
                pass
            
            self._broadcast(run_id, None)
            self._live_queues.pop(run_id, None)
            self._cancel_events.pop(run_id, None)

    async def _process_manifest_entry(
        self,
        ws_spec: dict,
        parent_workspace_id: str,
        project_id: str,
        follow_on_plan_ids: Optional[List[str]] = None,
        seen_workspaces: Optional[dict] = None,
        den_id: str = "local",
    ) -> None:
        """Create a single child workspace and schedule follow-on runs with database write throttling."""
        async with self._manifest_semaphore:
            await self._process_manifest_entry_raw(
                ws_spec=ws_spec,
                parent_workspace_id=parent_workspace_id,
                project_id=project_id,
                follow_on_plan_ids=follow_on_plan_ids,
                seen_workspaces=seen_workspaces,
                den_id=den_id,
            )

    async def _process_manifest_entry_raw(
        self,
        ws_spec: dict,
        parent_workspace_id: str,
        project_id: str,
        follow_on_plan_ids: Optional[List[str]] = None,
        seen_workspaces: Optional[dict] = None,
        den_id: str = "local",
    ) -> None:
        """Create a single child workspace and schedule follow-on runs."""
        from routers.plans import _find_plan

        ws_name = ws_spec.get("name", "").strip()
        if not ws_name:
            return

        entry_type = ws_spec.get("type", "host")
        effective_target = ws_name if entry_type == "path" else f"https://{ws_name}"

        try:
            child_ws = await deps.workspace_service.create_workspace(
                name=ws_name,
                project_id=project_id,
                parent_id=parent_workspace_id,
            )
            child_root = deps.WORKSPACES_DIR / project_id / child_ws.id

            if seen_workspaces is not None:
                seen_workspaces[ws_name] = child_ws.id

            for rel_path, content in ws_spec.get("files", {}).items():
                try:
                    target = child_root / rel_path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(str(content), encoding="utf-8")
                except Exception as fe:
                    _log.warning("manifest_entry: could not write file %s: %s", rel_path, fe)

            plans_to_fire: List[tuple[str, str]] = []
            if follow_on_plan_ids:
                for pid in follow_on_plan_ids:
                    if pid:
                        plans_to_fire.append((pid, effective_target))
            else:
                for run_spec in ws_spec.get("runs", []):
                    pid = run_spec.get("plan_id", "")
                    if pid:
                        plans_to_fire.append((pid, run_spec.get("target_url", effective_target)))

            for plan_id, plan_target in plans_to_fire:
                child_plan = _find_plan(plan_id)
                if child_plan and child_plan.get("tool") == "script":
                    child_run_id = str(uuid.uuid4())
                    child_run = Run(
                        id=child_run_id,
                        workspace_id=child_ws.id,
                        project_id=project_id,
                        plan_id=plan_id,
                        target_url=plan_target,
                        status="pending",
                        created_at=datetime.utcnow(),
                        den_id=den_id,
                    )
                    await self.db_client.create_run(child_run)
                    if den_id != "local":
                        # Fan-out: ensure runner capacity exists on the targeted Den
                        asyncio.create_task(
                            deps.fargate_orchestrator.ensure_runner_capacity(den_id, 1)
                        )
                    else:
                        asyncio.create_task(
                            self.execute_run_in_background(
                                run_id=child_run_id,
                                workspace_id=child_ws.id,
                                project_id=project_id,
                                plan=child_plan,
                                target_url=plan_target,
                            )
                        )
            _log.info("manifest_entry: created child workspace %s (%s)", child_ws.id, ws_name)
        except Exception as exc:
            _log.warning("manifest_entry: failed to create workspace %r: %s", ws_name, exc)

    async def _process_manifest(
        self,
        ws_root: Path,
        parent_workspace_id: str,
        project_id: str,
        seen_workspaces: Optional[dict] = None,
        den_id: str = "local",
    ) -> None:
        """Process local ferret_manifest.json on completion."""
        manifest_path = ws_root / "notes" / "ferret_manifest.json"
        if not manifest_path.exists():
            return

        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:
            _log.warning("failed to parse ferret_manifest.json: %s", exc)
            return

        for ws_spec in manifest.get("workspaces", []):
            ws_name = ws_spec.get("name", "").strip()
            if not ws_name:
                continue
            if seen_workspaces and ws_name in seen_workspaces:
                continue
            await self._process_manifest_entry(
                ws_spec=ws_spec,
                parent_workspace_id=parent_workspace_id,
                project_id=project_id,
                seen_workspaces=seen_workspaces,
                den_id=den_id,
            )

    async def start_scheduler(self) -> None:
        """Clean up orphaned 'running' runs and launch the background pending runs scheduler."""
        try:
            async with self.db_client._db.execute("SELECT id FROM runs WHERE status = 'running'") as cur:
                rows = await cur.fetchall()
            for row in rows:
                run_id = row[0]
                await self.db_client.update_run_status(
                    run_id,
                    status="error",
                    finished_at=datetime.utcnow(),
                )
                _log.info("Reset orphaned running run %s to error status", run_id)
        except Exception as e:
            _log.warning("Failed to clean up orphaned running runs: %s", e)

        asyncio.create_task(self._scheduler_loop())

    async def _scheduler_loop(self) -> None:
        """Poll database for pending runs and dispatch them asynchronously."""
        from routers.plans import _find_plan

        while True:
            try:
                # Check and maintain warm Fargate runner pools
                await self._maintain_warm_pools()

                # Query pending local runs in creation order (oldest first)
                async with self.db_client._db.execute(
                    "SELECT id, workspace_id, project_id, plan_id, target_url, follow_on_plan_id, follow_on_path_plan_id FROM runs WHERE status = 'pending' AND COALESCE(den_id, 'local') = 'local' ORDER BY created_at ASC"
                ) as cur:
                    rows = await cur.fetchall()

                for row in rows:
                    run_id = row[0]
                    if run_id in self._scheduled_run_ids:
                        continue

                    workspace_id = row[1]
                    project_id = row[2]
                    plan_id = row[3]
                    target_url = row[4]

                    def _parse_ids(raw):
                        if not raw:
                            return []
                        try:
                            parsed = json.loads(raw)
                            return parsed if isinstance(parsed, list) else [parsed]
                        except Exception:
                            return [raw]

                    follow_on_plan_ids = _parse_ids(row[5])
                    follow_on_path_plan_ids = _parse_ids(row[6])

                    plan = _find_plan(plan_id)
                    if not plan:
                        _log.warning("Scheduler: plan %s not found for pending run %s", plan_id, run_id)
                        await self.db_client.update_run_status(
                            run_id,
                            status="error",
                            finished_at=datetime.utcnow(),
                        )
                        continue

                    # Dispatch the run in the background
                    asyncio.create_task(
                        self.execute_run_in_background(
                            run_id=run_id,
                            workspace_id=workspace_id,
                            project_id=project_id,
                            plan=plan,
                            target_url=target_url,
                            follow_on_plan_ids=follow_on_plan_ids,
                            follow_on_path_plan_ids=follow_on_path_plan_ids,
                        )
                    )

            except Exception as e:
                _log.error("Scheduler loop error: %s", e, exc_info=True)

            await asyncio.sleep(5)

    _last_spawn_times = {}

    async def _maintain_warm_pools(self) -> None:
        """Query all AWS Dens and replenish warm runner pools if needed."""
        try:
            # Prevent duplicate spawning storm on startup/rebuild: Allow 60 seconds grace period
            # for existing living warm runners to send their heartbeats and register.
            if time.time() - self._startup_time < 60.0:
                _log.debug("Skipping warm pool maintenance during startup grace period.")
                return

            dens = await self.db_client.get_dens()
            active_runners = await self.db_client.get_active_runners(timeout_seconds=30)
            
            for den in dens:
                if den.get("type") != "aws":
                    continue
                
                warm_count = den.get("warm_runners") or 0
                if warm_count <= 0:
                    continue
                
                den_id = den["id"]
                
                # Check spawn cool-down (e.g. wait at least 60 seconds between warm pool spawn attempts)
                now = time.time()
                last_spawn = self._last_spawn_times.get(den_id, 0.0)
                if now - last_spawn < 60.0:
                    continue
                
                # Count current active+provisioning runners for this specific Den
                # (provisioning = ECS task launched but not yet booted)
                den_active_count = len([
                    r for r in active_runners
                    if r["id"].startswith(f"runner-fargate-{den_id}-")
                    and r.get("status") in ("active", "provisioning")
                ])
                
                if den_active_count < warm_count:
                    needed = warm_count - den_active_count
                    _log.info("[WARM_POOL] Den '%s' has %d active runners, needs %d warm runners. Spawning %d more...", den_id, den_active_count, warm_count, needed)
                    self._last_spawn_times[den_id] = now
                    asyncio.create_task(
                        deps.fargate_orchestrator.spawn_runners_if_needed(den_id, needed, is_warm=True)
                    )
        except Exception as err:
            _log.warning("Error maintaining warm pools: %s", err)

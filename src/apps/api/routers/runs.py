"""
Runs router — automated script plan executions.

A Run executes a script plan (tool: script) against a target URL within a
workspace.  The script runs in the sandbox container; output is streamed live
via WebSocket and written to a log file in the workspace.

On clean exit (rc=0) the runner checks for notes/ferret_manifest.json and
processes it: creating child workspaces, writing files, and optionally
scheduling follow-on runs.

Routes
------
  GET    /api/runs?project_id=…          list runs for project
  GET    /api/runs?workspace_id=…        list runs for workspace
  POST   /api/runs                       create run (+ workspace if needed)
  GET    /api/runs/{id}                  run detail
  WS     /api/runs/{id}/ws              WebSocket: live script output
  GET    /api/runs/{id}/files            workspace files
  POST   /api/runs/{id}/cancel           cancel a running run
  POST   /api/runs/{id}/rerun            rerun with same plan/target
  DELETE /api/runs/{id}
"""

import asyncio
import json
import logging
import re
import time as _time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

import deps
from models import Run, RunCreate

_log = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# In-memory live-output queues: run_id → asyncio.Queue[str | None]
# A chunk of str is a raw output line; None is the sentinel that signals end.
# ---------------------------------------------------------------------------
_live_queues: dict[str, list["asyncio.Queue[str | None]"]] = {}

# ---------------------------------------------------------------------------
# Cancellation events: run_id → asyncio.Event
# Set by the cancel endpoint; checked by the background runner each chunk.
# ---------------------------------------------------------------------------
_cancel_events: dict[str, asyncio.Event] = {}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/api/runs")
async def list_runs(
    project_id: Optional[str] = None,
    workspace_id: Optional[str] = None,
):
    """List runs, filtered by workspace_id or project_id."""
    try:
        runs = await deps.db_client.get_runs(
            workspace_id=workspace_id,
            project_id=project_id or "temp",
        )
        return runs
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/runs", status_code=201)
async def create_run(body: RunCreate, project_id: str = "temp"):
    """Create a new run.

    If workspace_id is not supplied, a new workspace is created automatically
    using workspace_name (or the target_url as a fallback name).
    """
    try:
        from plans import _find_plan
        from workspaces import create_workspace as _create_workspace

        plan = _find_plan(body.plan_id)
        if not plan:
            raise HTTPException(status_code=404, detail=f"Plan '{body.plan_id}' not found")
        if plan.get("tool") != "script":
            raise HTTPException(
                status_code=400,
                detail=f"Plan '{body.plan_id}' has tool='{plan.get('tool')}'; only script plans can be used for runs",
            )

        # Resolve or create workspace
        if body.workspace_id:
            ws = await deps.db_client.get_workspace(body.workspace_id)
            if not ws:
                raise HTTPException(status_code=404, detail=f"Workspace '{body.workspace_id}' not found")
            workspace_id = body.workspace_id
        else:
            ws_name = body.workspace_name or body.target_url or "workspace"
            ws_obj = await _create_workspace(name=ws_name, project_id=project_id)
            workspace_id = ws_obj.id

        run_id = str(uuid.uuid4())
        run = Run(
            id=run_id,
            workspace_id=workspace_id,
            project_id=project_id,
            plan_id=body.plan_id,
            target_url=body.target_url,
            status="pending",
            created_at=datetime.utcnow(),
            follow_on_plan_ids=body.follow_on_plan_ids,
            follow_on_path_plan_ids=body.follow_on_path_plan_ids,
        )
        await deps.db_client.create_run(run)

        # Fire the script runner as a background task
        asyncio.create_task(
            _run_script_in_background(
                run_id=run_id,
                workspace_id=workspace_id,
                project_id=project_id,
                plan=plan,
                target_url=body.target_url,
                follow_on_plan_ids=body.follow_on_plan_ids,
                follow_on_path_plan_ids=body.follow_on_path_plan_ids,
            )
        )

        return run.model_dump()
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/runs/{run_id}")
async def get_run(run_id: str):
    """Get a single run by ID."""
    try:
        run = await deps.db_client.get_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
        return run
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.websocket("/api/runs/{run_id}/ws")
async def stream_run_output_ws(websocket: WebSocket, run_id: str):
    """WebSocket endpoint: stream live output for a running run, or replay log for a completed run.

    For active runs, subscribes to the in-memory queue populated by the background runner
    so output is delivered immediately as individual WebSocket frames (no HTTP buffering).
    For completed runs, replays the log file then closes.

    Message format (JSON):
      {"line": "<raw output line>"}   — output chunk
      {"status": "done"|"error", "exit_code": int|null}  — terminal message, server closes after
    """
    await websocket.accept()
    run = await deps.db_client.get_run(run_id)
    if not run:
        await websocket.close(code=1008, reason="Run not found")
        return

    try:
        # --- Completed run: replay log file then close ---
        if run["status"] in ("done", "error"):
            log_path = _resolve_log_path(run)
            if log_path and log_path.exists():
                content = log_path.read_text(encoding="utf-8", errors="replace")
                for line in content.splitlines(keepends=True):
                    await websocket.send_text(json.dumps({"line": line}))
            await websocket.send_text(json.dumps({"status": run["status"], "exit_code": run.get("exit_code")}))
            await websocket.close()
            return

        # --- Active / pending run: replay partial log then subscribe to live queue ---
        # Replay whatever has been written to the log file so far so that clients
        # reconnecting mid-run see all prior output, not just new lines.
        log_path = _resolve_log_path(run)
        replay_lines = 0
        if log_path and log_path.exists():
            try:
                content = log_path.read_text(encoding="utf-8", errors="replace")
                for line in content.splitlines(keepends=True):
                    await websocket.send_text(json.dumps({"line": line}))
                    replay_lines += 1
            except Exception as replay_exc:
                _log.warning("ws replay error run_id=%s: %s", run_id, replay_exc)

        # Re-check status after replay — run may have finished while we were reading
        run = await deps.db_client.get_run(run_id)
        if run and run["status"] in ("done", "error"):
            await websocket.send_text(json.dumps({"status": run["status"], "exit_code": run.get("exit_code")}))
            await websocket.close()
            return

        q: asyncio.Queue[str | None] = asyncio.Queue()
        _live_queues.setdefault(run_id, []).append(q)
        try:
            while True:
                try:
                    item = await asyncio.wait_for(q.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    # Heartbeat: check if run finished while queue was idle
                    current = await deps.db_client.get_run(run_id)
                    if current and current["status"] in ("done", "error"):
                        # Drain any remaining items
                        while not q.empty():
                            remaining = q.get_nowait()
                            if remaining is None:
                                break
                            await websocket.send_text(json.dumps({"line": remaining}))
                        await websocket.send_text(json.dumps({"status": current["status"], "exit_code": current.get("exit_code")}))
                        await websocket.close()
                        return
                    continue
                if item is None:
                    # Sentinel: run finished — fetch final status
                    current = await deps.db_client.get_run(run_id)
                    status = current["status"] if current else "done"
                    exit_code = current.get("exit_code") if current else None
                    await websocket.send_text(json.dumps({"status": status, "exit_code": exit_code}))
                    await websocket.close()
                    return
                await websocket.send_text(json.dumps({"line": item}))
        finally:
            # Unsubscribe from queue
            listeners = _live_queues.get(run_id, [])
            if q in listeners:
                listeners.remove(q)
            if not listeners:
                _live_queues.pop(run_id, None)

    except WebSocketDisconnect:
        # Client disconnected — clean up is handled in the finally block above
        pass
    except Exception as exc:
        _log.error("ws stream error run_id=%s: %s", run_id, exc, exc_info=True)
        try:
            await websocket.close(code=1011)
        except Exception:
            pass


@router.get("/api/runs/{run_id}/files")
async def get_run_files(run_id: str):
    """List workspace files for a run (delegates to workspace file listing)."""
    try:
        run = await deps.db_client.get_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")

        ws_root = deps.WORKSPACES_DIR / run["project_id"] / run["workspace_id"]
        files = []
        if ws_root.exists():
            for subdir in ("workspace", "scripts", "tests", "notes", "credentials", "source", "docs"):
                subdir_path = ws_root / subdir
                if subdir_path.exists():
                    for f in sorted(subdir_path.iterdir()):
                        if f.is_file():
                            files.append({
                                "path": f"{subdir}/{f.name}",
                                "subdir": subdir,
                                "name": f.name,
                                "size": f.stat().st_size,
                            })
        return {"files": files}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/runs/{run_id}/rerun", status_code=201)
async def rerun_run(run_id: str):
    """Create a new run using the same plan, target, and workspace as an existing run."""
    try:
        from plans import _find_plan

        source = await deps.db_client.get_run(run_id)
        if not source:
            raise HTTPException(status_code=404, detail="Run not found")

        plan = _find_plan(source["plan_id"])
        if not plan:
            raise HTTPException(status_code=404, detail=f"Plan '{source['plan_id']}' not found")

        new_run_id = str(uuid.uuid4())
        follow_on_plan_ids = source.get("follow_on_plan_ids") or []
        follow_on_path_plan_ids = source.get("follow_on_path_plan_ids") or []
        new_run = Run(
            id=new_run_id,
            workspace_id=source["workspace_id"],
            project_id=source["project_id"],
            plan_id=source["plan_id"],
            target_url=source["target_url"],
            follow_on_plan_ids=follow_on_plan_ids,
            follow_on_path_plan_ids=follow_on_path_plan_ids,
            status="pending",
            created_at=datetime.utcnow(),
        )
        await deps.db_client.create_run(new_run)

        asyncio.create_task(
            _run_script_in_background(
                run_id=new_run_id,
                workspace_id=source["workspace_id"],
                project_id=source["project_id"],
                plan=plan,
                target_url=source["target_url"],
                follow_on_plan_ids=follow_on_plan_ids,
                follow_on_path_plan_ids=follow_on_path_plan_ids,
            )
        )

        return new_run.model_dump()
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/runs/{run_id}", status_code=204)
async def delete_run(run_id: str):
    """Delete a run record (does not delete workspace files)."""
    try:
        ok = await deps.db_client.delete_run(run_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Run not found")
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/runs/{run_id}/cancel", status_code=200)
async def cancel_run(run_id: str):
    """Request cancellation of an active run.

    Sets the in-memory cancel event and immediately kills the subprocess via the
    process registry in chats_runners.  The background runner will then write a
    cancellation notice, mark the run as 'error' (exit_code=-1), and signal SSE
    subscribers.  No-op if the run is already finished.
    """
    from chats_runners import _run_procs

    run = await deps.db_client.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["status"] not in ("pending", "running"):
        return {"status": run["status"], "cancelled": False, "detail": "Run already finished"}

    # Set the cancel event so the background runner writes the cancellation notice
    event = _cancel_events.get(run_id)
    if event:
        event.set()

    # Kill the subprocess immediately so readline() unblocks right away
    proc = _run_procs.get(run_id)
    if proc is not None:
        try:
            proc.kill()
        except Exception:
            pass

    return {"status": "cancelling", "cancelled": True}


# ---------------------------------------------------------------------------
# Background runner
# ---------------------------------------------------------------------------

async def _run_script_in_background(
    run_id: str,
    workspace_id: str,
    project_id: str,
    plan: dict,
    target_url: str,
    follow_on_plan_ids: Optional[List[str]] = None,
    follow_on_path_plan_ids: Optional[List[str]] = None,
) -> None:
    """Execute a script plan in the background, stream output to a log file,
    and process ferret_manifest.json on clean exit.

    Streaming manifest protocol: the script may emit lines of the form
        [FERRET:MANIFEST] <json>
    where <json> is a workspace spec dict (same format as ferret_manifest.json
    workspace entries).  Each such line is processed immediately — the child
    workspace is created and any follow-on run is fired — without waiting for
    the script to finish.  Duplicate workspace names are deduplicated.
    """
    from chats_runners import stream_run_script

    try:
        # Register a cancellation event for this run
        cancel_event = asyncio.Event()
        _cancel_events[run_id] = cancel_event

        # Deduplication: name → child_workspace_id for streaming manifest entries.
        # Pre-populate from existing children so reruns don't create duplicate workspaces
        # or fire follow-on runs against hosts that already have a child workspace.
        existing_children = await deps.db_client.get_workspaces(project_id)
        seen_workspaces: dict[str, str] = {
            ws["name"]: ws["id"]
            for ws in existing_children
            if ws.get("parent_id") == workspace_id
        }
        if seen_workspaces:
            _log.info(
                "run %s: pre-seeded seen_workspaces with %d existing children",
                run_id, len(seen_workspaces),
            )

        # Mark as running
        await deps.db_client.update_run_status(
            run_id,
            status="running",
            started_at=datetime.now(timezone.utc),
        )

        # Resolve workspace path
        ws_root = deps.WORKSPACES_DIR / project_id / workspace_id

        # Prepare log file path
        log_filename = f"run_{run_id[:8]}.log"
        log_dir = ws_root / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / log_filename
        run_log_rel = f"logs/{log_filename}"

        # Update run with log path
        await deps.db_client.update_run_status(run_id, status="running", run_log_path=run_log_rel)

        # Extract domain from target_url (strip wildcard, scheme, path)
        domain = _extract_domain(target_url)

        # Container-visible workspace path
        # WORKSPACES_DIR is mounted into the sandbox — derive container path
        container_ws = _container_workspace_path(project_id, workspace_id)

        # Substitute placeholders in script body
        script = plan.get("prompt", "")
        script = script.replace("{{target}}", target_url)
        script = script.replace("{{domain}}", domain)
        script = script.replace("{{workspace}}", container_ws)
        script = script.replace("{{workspace_id}}", workspace_id)
        script = script.replace("{{session_id}}", run_id)
        script = script.replace("{{project_id}}", project_id)
        # {{follow_on_plan}} expands to the first plan ID for backward compat with scripts
        # that only support a single follow-on plan placeholder.
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

        # Stream output to log file AND broadcast to any live SSE subscribers
        exit_code = 0

        def _broadcast(line: str) -> None:
            """Push a line to all active SSE queues for this run."""
            for q in list(_live_queues.get(run_id, [])):
                try:
                    q.put_nowait(line)
                except asyncio.QueueFull:
                    pass

        with log_path.open("w", encoding="utf-8") as log_fh:
            streamer = stream_run_script(fn_args, project_id=project_id, session_id=run_id)
            async for chunk, is_final, final_result in streamer:
                # Check for cancellation after each chunk
                if cancel_event.is_set():
                    cancelled_msg = "\r\n[FERRET] Run cancelled by user.\r\n"
                    log_fh.write(cancelled_msg)
                    log_fh.flush()
                    _broadcast(cancelled_msg)
                    exit_code = -1
                    break
                if not is_final and chunk:
                    log_fh.write(chunk)
                    log_fh.flush()
                    # Broadcast each line to live SSE subscribers immediately.
                    # Also scan for [FERRET:MANIFEST] streaming workspace events.
                    for line in chunk.splitlines(keepends=True):
                        _broadcast(line)
                        stripped = line.strip()
                        if stripped.startswith("[FERRET:MANIFEST]"):
                            payload_str = stripped[len("[FERRET:MANIFEST]"):].strip()
                            try:
                                ws_spec = json.loads(payload_str)
                            except Exception:
                                _log.warning("run %s: malformed [FERRET:MANIFEST] line: %s", run_id, stripped)
                                continue
                            ws_name = ws_spec.get("name", "").strip()
                            if not ws_name:
                                continue
                            if ws_name in seen_workspaces:
                                # Duplicate: update existing workspace files only
                                existing_ws_id = seen_workspaces[ws_name]
                                for rel_path, content in ws_spec.get("files", {}).items():
                                    try:
                                        target = deps.WORKSPACES_DIR / project_id / existing_ws_id / rel_path
                                        target.parent.mkdir(parents=True, exist_ok=True)
                                        target.write_text(str(content), encoding="utf-8")
                                    except Exception as fe:
                                        _log.warning("run %s: could not update file %s in ws %s: %s", run_id, rel_path, existing_ws_id, fe)
                            else:
                                # New entry: create workspace and fire follow-on runs.
                                # Route to host or path follow-on list based on manifest type.
                                entry_type = ws_spec.get("type", "host")
                                if entry_type == "path":
                                    entry_follow_on = follow_on_path_plan_ids or []
                                else:
                                    entry_follow_on = follow_on_plan_ids or []
                                asyncio.create_task(
                                    _process_manifest_entry(
                                        ws_spec=ws_spec,
                                        parent_workspace_id=workspace_id,
                                        project_id=project_id,
                                        follow_on_plan_ids=entry_follow_on,
                                        seen_workspaces=seen_workspaces,
                                    )
                                )
                if is_final and final_result:
                    # Extract exit code from __META__
                    meta_idx = final_result.rfind("\n__META__:")
                    if meta_idx != -1:
                        try:
                            meta = json.loads(final_result[meta_idx + len("\n__META__:"):])
                            exit_code = meta.get("exit_code", 0) or 0
                        except Exception:
                            pass
                    # The final_result contains the full output again (all_chunks joined).
                    # We already wrote every live chunk above, so we must NOT write the
                    # full output a second time.  Only append the promotion notice, which
                    # is a short suffix appended after the output and before __META__.
                    # Extract it: promotion_notice sits between the last live chunk and __META__.
                    # Simplest heuristic: look for the [FERRET] ✓ promotion line.
                    promotion_marker = "\r\n[FERRET] ✓"
                    remainder = final_result[:meta_idx] if meta_idx != -1 else final_result
                    promo_idx = remainder.find(promotion_marker)
                    if promo_idx != -1:
                        promotion_only = remainder[promo_idx:]
                        log_fh.write(promotion_only)
                        for line in promotion_only.splitlines(keepends=True):
                            _broadcast(line)

        # Process manifest on clean exit (skips names already created via streaming)
        if exit_code == 0:
            await _process_manifest(ws_root, workspace_id, project_id, seen_workspaces=seen_workspaces)

        status = "done" if exit_code == 0 else "error"
        await deps.db_client.update_run_status(
            run_id,
            status=status,
            exit_code=exit_code,
            run_log_path=run_log_rel,
            finished_at=datetime.now(timezone.utc),
        )
        _log.info("run completed id=%s status=%s exit_code=%d", run_id, status, exit_code)

        # Signal all live SSE subscribers that the run is done
        for q in list(_live_queues.get(run_id, [])):
            try:
                q.put_nowait(None)  # sentinel
            except asyncio.QueueFull:
                pass
        _live_queues.pop(run_id, None)
        _cancel_events.pop(run_id, None)

    except Exception as exc:
        _log.error("run failed id=%s: %s", run_id, exc, exc_info=True)
        try:
            await deps.db_client.update_run_status(
                run_id,
                status="error",
                finished_at=datetime.now(timezone.utc),
            )
        except Exception:
            pass
        # Signal SSE subscribers even on unexpected failure
        for q in list(_live_queues.get(run_id, [])):
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                pass
        _live_queues.pop(run_id, None)
        _cancel_events.pop(run_id, None)


async def _process_manifest_entry(
    ws_spec: dict,
    parent_workspace_id: str,
    project_id: str,
    follow_on_plan_ids: Optional[List[str]] = None,
    seen_workspaces: Optional[dict] = None,
) -> None:
    """Create a single child workspace from a manifest entry and fire follow-on runs.

    This is called immediately when a [FERRET:MANIFEST] line is detected in the script output,
    enabling real-time workspace creation as hosts/paths are discovered.

    Args:
        ws_spec: Workspace spec dict with keys: name, type (host|path), files, runs (optional).
                 For type=path, 'name' should be the full URL including path.
        parent_workspace_id: ID of the parent workspace (the enum run's workspace).
        project_id: Project ID.
        follow_on_plan_ids: Plans to run against the new workspace (already filtered by type).
                            One run is fired per plan ID.
        seen_workspaces: Shared dict mapping name→workspace_id for deduplication.
                         Updated in-place when a new workspace is created.
    """
    from workspaces import create_workspace as _create_workspace
    from plans import _find_plan

    ws_name = ws_spec.get("name", "").strip()
    if not ws_name:
        return

    entry_type = ws_spec.get("type", "host")
    # For path entries the name IS the full URL; for host entries prepend https://
    if entry_type == "path":
        effective_target = ws_name  # already a full URL
    else:
        effective_target = f"https://{ws_name}"

    try:
        child_ws = await _create_workspace(
            name=ws_name,
            project_id=project_id,
            parent_id=parent_workspace_id,
        )
        child_root = deps.WORKSPACES_DIR / project_id / child_ws.id

        # Register in dedup map
        if seen_workspaces is not None:
            seen_workspaces[ws_name] = child_ws.id

        # Write files into the child workspace
        for rel_path, content in ws_spec.get("files", {}).items():
            try:
                target = child_root / rel_path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(str(content), encoding="utf-8")
            except Exception as fe:
                _log.warning("manifest_entry: could not write file %s in ws %s: %s", rel_path, child_ws.id, fe)

        # Determine which plans to fire:
        # explicit follow_on_plan_ids takes precedence over ws_spec runs[]
        plans_to_fire: List[tuple[str, str]] = []  # (plan_id, target_url)
        if follow_on_plan_ids:
            for pid in follow_on_plan_ids:
                if pid:
                    plans_to_fire.append((pid, effective_target))
        else:
            # Fall back to runs[] in the spec
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
                )
                await deps.db_client.create_run(child_run)
                asyncio.create_task(
                    _run_script_in_background(
                        run_id=child_run_id,
                        workspace_id=child_ws.id,
                        project_id=project_id,
                        plan=child_plan,
                        target_url=plan_target,
                    )
                )
                _log.info("manifest_entry: fired follow-on run %s (plan=%s) for ws %s", child_run_id, plan_id, ws_name)

        _log.info("manifest_entry: created child workspace %s (%s)", child_ws.id, ws_name)
    except Exception as exc:
        _log.warning("manifest_entry: failed to create workspace %r: %s", ws_name, exc)


async def _process_manifest(
    ws_root: Path,
    parent_workspace_id: str,
    project_id: str,
    seen_workspaces: Optional[dict] = None,
) -> None:
    """Read notes/ferret_manifest.json and execute it: create child workspaces,
    write files, and optionally schedule follow-on runs.

    Skips workspace names already present in seen_workspaces (created via streaming
    [FERRET:MANIFEST] lines during the run) to avoid duplicates.
    """
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
        # Skip if already created via streaming manifest during the run
        if seen_workspaces and ws_name in seen_workspaces:
            _log.debug("manifest: skipping %r (already created via streaming)", ws_name)
            continue
        await _process_manifest_entry(
            ws_spec=ws_spec,
            parent_workspace_id=parent_workspace_id,
            project_id=project_id,
            seen_workspaces=seen_workspaces,
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _extract_domain(target_url: str) -> str:
    """Strip wildcard prefix, scheme, and path from a target URL to get the base domain.

    Examples:
        *.hilton.com        → hilton.com
        https://hilton.com  → hilton.com
        hilton.com/path     → hilton.com
    """
    s = target_url.strip()
    # Strip wildcard
    s = re.sub(r"^\*\.", "", s)
    # Strip scheme
    s = re.sub(r"^https?://", "", s)
    # Strip path and query
    s = s.split("/")[0].split("?")[0].split("#")[0]
    return s


def _container_workspace_path(project_id: str, workspace_id: str) -> str:
    """Return the workspace path as seen from inside the sandbox container.

    The WORKSPACES_DIR is mounted into the sandbox at the same path by default.
    If FERRET_CONTAINER_WORKSPACES_DIR is set, that override is used instead.
    """
    import os
    container_base = os.getenv(
        "FERRET_CONTAINER_WORKSPACES_DIR",
        str(deps.WORKSPACES_DIR),
    )
    return f"{container_base}/{project_id}/{workspace_id}"


def _resolve_log_path(run: dict) -> Optional[Path]:
    """Resolve the absolute log file path for a run, or None if not set."""
    run_log_path = run.get("run_log_path")
    if not run_log_path:
        return None
    return deps.WORKSPACES_DIR / run["project_id"] / run["workspace_id"] / run_log_path

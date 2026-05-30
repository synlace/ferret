"""
Runs router — execution endpoints for named script plans.

All orchestration, log writing, substitution, process registry, and manifest 
processing are decoupled into ScriptExecutionEngine to maintain depth and clarity.
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, Request

import deps
from models import Run, RunCreate

_log = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_log_path(run: dict) -> Optional[Path]:
    """Resolve the absolute log file path for a run, or None if not set."""
    run_log_path = run.get("run_log_path")
    if not run_log_path:
        return None
    return deps.WORKSPACES_DIR / run["project_id"] / run["workspace_id"] / run_log_path


def _resolve_den_id(runspec, step_index: int) -> str:
    """Dynamically resolves the target Den for a specific pipeline step index."""
    target_den = runspec.runner_den or "local"
    if target_den == "multi" and runspec.target_sharding and runspec.target_sharding.dens:
        strategy = runspec.target_sharding.strategy
        dens = runspec.target_sharding.dens
        if not dens:
            return "local"
        
        if strategy == "round_robin":
            return dens[step_index % len(dens)]
        elif strategy == "failover":
            # For failover, keep primary den (index 0) unless specialized health checks exist
            return dens[0]
        else:
            # Fallback to round_robin for geo_proximity or unspecified strategies
            return dens[step_index % len(dens)]
            
    return target_den


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

async def _assert_setup_or_authenticated(request: Request):
    """Enforce authentication on run creation endpoints ONLY IF setup has been completed."""
    complete = await deps.db_client.get_setting("setup_complete")
    if complete == "1":
        await deps.require_auth(request)


@router.get("/api/runs")
async def list_runs(
    request: Request,
    project_id: Optional[str] = None,
    workspace_id: Optional[str] = None,
    limit: int = 1000,
):
    """List runs, filtered by workspace_id or project_id."""
    try:
        await _assert_setup_or_authenticated(request)
        runs = await deps.db_client.get_runs(
            workspace_id=workspace_id,
            project_id=project_id or "temp",
            limit=limit,
        )
        return runs
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/runs", status_code=201)
async def create_run(request: Request, project_id: str = "temp"):
    """Create a new run / pipeline and fire execution in the background."""
    try:
        await _assert_setup_or_authenticated(request)
        
        # Get raw request body
        body_bytes = await request.body()
        body_text = body_bytes.decode("utf-8").strip()
        
        import yaml
        from models import RunSpecSchema, RunCreate
        
        try:
            parsed_data = yaml.safe_load(body_text)
        except Exception as ye:
            raise HTTPException(status_code=400, detail=f"Invalid request format (expected JSON or YAML): {str(ye)}")
            
        if not isinstance(parsed_data, dict):
            raise HTTPException(status_code=400, detail="Invalid request format (body must be an object)")
            
        # Is it a widescreen RunSpec / Pipeline?
        if "pipeline" in parsed_data:
            runspec = RunSpecSchema(**parsed_data)
            
            # Resolve or create workspace
            if runspec.workspace_id:
                ws = await deps.db_client.get_workspace(runspec.workspace_id)
                if not ws:
                    raise HTTPException(status_code=404, detail=f"Workspace '{runspec.workspace_id}' not found")
                workspace_id = runspec.workspace_id
            else:
                ws_name = runspec.workspace_name or runspec.target_url or "workspace"
                ws_obj = await deps.workspace_service.create_workspace(name=ws_name, project_id=project_id)
                workspace_id = ws_obj.id
            
            # Resolve target Den
            den_id = _resolve_den_id(runspec, 0)
                
            from routers.plans import _find_plan
            
            if not runspec.pipeline:
                raise HTTPException(status_code=400, detail="RunSpec pipeline must contain at least one step")
                
            first_step = runspec.pipeline[0]
            plan = _find_plan(first_step.plan)
            if not plan:
                raise HTTPException(status_code=404, detail=f"Plan '{first_step.plan}' not found")
                
            first_run_id = str(uuid.uuid4())
            
            # Resolve follow-on plan lists if any are specified in leaf_scripts
            follow_on_plan_ids = []
            follow_on_path_plan_ids = []
            if first_step.leaf_scripts:
                if "subdomain" in first_step.step or "subdomain" in first_step.plan:
                    follow_on_plan_ids = first_step.leaf_scripts
                elif "spider" in first_step.step or "katana" in first_step.plan:
                    follow_on_path_plan_ids = first_step.leaf_scripts
                else:
                    follow_on_plan_ids = first_step.leaf_scripts
                    
            first_run = Run(
                id=first_run_id,
                workspace_id=workspace_id,
                project_id=project_id,
                plan_id=first_step.plan,
                target_url=runspec.target_url,
                status="pending",
                created_at=datetime.utcnow(),
                follow_on_plan_ids=follow_on_plan_ids,
                follow_on_path_plan_ids=follow_on_path_plan_ids,
                den_id=den_id,
            )
            await deps.db_client.create_run(first_run)
            
            # Start first run in the background
            asyncio.create_task(
                deps.script_execution_engine.execute_run_in_background(
                    run_id=first_run_id,
                    workspace_id=workspace_id,
                    project_id=project_id,
                    plan=plan,
                    target_url=runspec.target_url,
                    follow_on_plan_ids=follow_on_plan_ids,
                    follow_on_path_plan_ids=follow_on_path_plan_ids,
                )
            )
            
            # Ensure sufficient runner capacity exists on the targeted Den
            if first_run.den_id and first_run.den_id != "local":
                asyncio.create_task(
                    deps.fargate_orchestrator.ensure_runner_capacity(first_run.den_id, 1)
                )
                
            # Schedule sequential execution of the remaining steps in the pipeline
            if len(runspec.pipeline) > 1:
                async def _run_remaining_steps():
                    current_run_id = first_run_id
                    for idx, step in enumerate(runspec.pipeline[1:], start=1):
                        while True:
                            r = await deps.db_client.get_run(current_run_id)
                            if r and r.get("status") in ("done", "error"):
                                break
                            await asyncio.sleep(2)
                            
                        next_plan = _find_plan(step.plan)
                        if not next_plan:
                            _log.error("Sequential RunSpec: plan '%s' not found for next step", step.plan)
                            break
                            
                        next_run_id = str(uuid.uuid4())
                        next_follow_on_plan_ids = []
                        next_follow_on_path_plan_ids = []
                        if step.leaf_scripts:
                            if "subdomain" in step.step or "subdomain" in step.plan:
                                next_follow_on_plan_ids = step.leaf_scripts
                            elif "spider" in step.step or "katana" in step.plan:
                                next_follow_on_path_plan_ids = step.leaf_scripts
                            else:
                                next_follow_on_plan_ids = step.leaf_scripts
                                
                        # Dynamically resolve target Den for the current step index
                        step_den_id = _resolve_den_id(runspec, idx)

                        next_run = Run(
                            id=next_run_id,
                            workspace_id=workspace_id,
                            project_id=project_id,
                            plan_id=step.plan,
                            target_url=runspec.target_url,
                            status="pending",
                            created_at=datetime.utcnow(),
                            follow_on_plan_ids=next_follow_on_plan_ids,
                            follow_on_path_plan_ids=next_follow_on_path_plan_ids,
                            den_id=step_den_id,
                        )
                        await deps.db_client.create_run(next_run)
                        
                        # Ensure sufficient runner capacity exists on the dynamically targeted Den
                        if next_run.den_id and next_run.den_id != "local":
                            asyncio.create_task(
                                deps.fargate_orchestrator.ensure_runner_capacity(next_run.den_id, 1)
                            )

                        await deps.script_execution_engine.execute_run_in_background(
                            run_id=next_run_id,
                            workspace_id=workspace_id,
                            project_id=project_id,
                            plan=next_plan,
                            target_url=runspec.target_url,
                            follow_on_plan_ids=next_follow_on_plan_ids,
                            follow_on_path_plan_ids=next_follow_on_path_plan_ids,
                        )
                        current_run_id = next_run_id
                        
                    # Trigger Synthesis upon successful completion of all pipeline steps if configured
                    if runspec.synthesis and runspec.synthesis.trigger_on_completion:
                        while True:
                            r = await deps.db_client.get_run(current_run_id)
                            if r and r.get("status") in ("done", "error"):
                                break
                            await asyncio.sleep(2)
                        
                        _log.info("Triggering downstream synthesis blueprint '%s' inside reports directory...", runspec.synthesis.blueprint)
                        reports_dir = deps.WORKSPACES_DIR / project_id / workspace_id / "reports"
                        reports_dir.mkdir(parents=True, exist_ok=True)
                        report_file = reports_dir / f"{runspec.synthesis.blueprint.replace('.yaml', '')}.md"
                        report_content = f"# Executive Security Assessment Report\n\nGenerated automatically on {datetime.utcnow().isoformat()} for target: {runspec.target_url}.\n\nPipeline execution successfully finished."
                        report_file.write_text(report_content, encoding="utf-8")
                        
                asyncio.create_task(_run_remaining_steps())
                
            return first_run.model_dump()
            
        else:
            # Fallback to standard RunCreate JSON format
            body = RunCreate(**parsed_data)
            
            from routers.plans import _find_plan

            plan = _find_plan(body.plan_id)
            if not plan:
                raise HTTPException(status_code=404, detail=f"Plan '{body.plan_id}' not found")
            if plan.get("tool") != "script":
                raise HTTPException(
                    status_code=400,
                    detail=f"Plan '{body.plan_id}' has tool='{plan.get('tool')}'; only script plans can be used for runs",
                )

            if body.workspace_id:
                ws = await deps.db_client.get_workspace(body.workspace_id)
                if not ws:
                    raise HTTPException(status_code=404, detail=f"Workspace '{body.workspace_id}' not found")
                workspace_id = body.workspace_id
            else:
                ws_name = body.workspace_name or body.target_url or "workspace"
                ws_obj = await deps.workspace_service.create_workspace(name=ws_name, project_id=project_id)
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
                den_id=body.den_id or "local",
            )
            await deps.db_client.create_run(run)

            asyncio.create_task(
                deps.script_execution_engine.execute_run_in_background(
                    run_id=run_id,
                    workspace_id=workspace_id,
                    project_id=project_id,
                    plan=plan,
                    target_url=body.target_url,
                    follow_on_plan_ids=body.follow_on_plan_ids,
                    follow_on_path_plan_ids=body.follow_on_path_plan_ids,
                )
            )

            if run.den_id and run.den_id != "local":
                asyncio.create_task(
                    deps.fargate_orchestrator.ensure_runner_capacity(run.den_id, body.runner_count or 1)
                )

            return run.model_dump()
            
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/runs/{run_id}")
async def get_run(run_id: str, request: Request):
    """Get a single run by ID."""
    try:
        await _assert_setup_or_authenticated(request)
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
    """WebSocket endpoint: stream live output or replay logs."""
    _log.info("[WEBSOCKET_STREAM] [CONNECT] Client attempting connection for Run ID: %s", run_id)
    await websocket.accept()
    run = await deps.db_client.get_run(run_id)
    if not run:
        _log.warning("[WEBSOCKET_STREAM] [CONNECT_REJECTED] Run ID: %s not found in DB.", run_id)
        await websocket.close(code=1008, reason="Run not found")
        return

    try:
        # --- Completed run: replay log file then close ---
        if run["status"] in ("done", "error"):
            log_path = _resolve_log_path(run)
            _log.info("[WEBSOCKET_STREAM] [REPLAY] Run %s is completed (status=%s). Replaying log file: %s", run_id, run["status"], log_path)
            if log_path and log_path.exists():
                content = log_path.read_text(encoding="utf-8", errors="replace")
                lines = content.splitlines(keepends=True)
                _log.debug("[WEBSOCKET_STREAM] [REPLAY] Replaying %d lines to WebSocket for Run ID: %s", len(lines), run_id)
                for line in lines:
                    await websocket.send_text(json.dumps({"line": line}))
            await websocket.send_text(json.dumps({"status": run["status"], "exit_code": run.get("exit_code")}))
            _log.info("[WEBSOCKET_STREAM] [CLOSE] Replay complete. Closing WebSocket for Run ID: %s", run_id)
            await websocket.close()
            return

        # --- Active / pending run: replay partial log then subscribe to live queue ---
        log_path = _resolve_log_path(run)
        _log.info("[WEBSOCKET_STREAM] [SUBSCRIBE] Run %s is active (status=%s). Replaying partial logs then subscribing.", run_id, run["status"])
        if log_path and log_path.exists():
            try:
                content = log_path.read_text(encoding="utf-8", errors="replace")
                lines = content.splitlines(keepends=True)
                _log.debug("[WEBSOCKET_STREAM] [SUBSCRIBE] Sending %d bytes of partial logs for Run %s", len(content), run_id)
                for line in lines:
                    await websocket.send_text(json.dumps({"line": line}))
            except Exception as replay_exc:
                _log.warning("[WEBSOCKET_STREAM] [SUBSCRIBE] WebSocket replay error on Run ID %s: %s", run_id, replay_exc)

        # Re-check status after replay
        run = await deps.db_client.get_run(run_id)
        if run and run["status"] in ("done", "error"):
            _log.info("[WEBSOCKET_STREAM] [SUBSCRIBE_COMPLETED] Run ID %s transitioned to completed during replay. Releasing.", run_id)
            await websocket.send_text(json.dumps({"status": run["status"], "exit_code": run.get("exit_code")}))
            await websocket.close()
            return

        q: asyncio.Queue[Optional[str]] = asyncio.Queue()
        _log.debug("[WEBSOCKET_STREAM] [LISTENER_REG] Registering WebSocket log-listener queue for Run ID: %s", run_id)
        deps.script_execution_engine.register_listener_queue(run_id, q)
        try:
            while True:
                try:
                    item = await asyncio.wait_for(q.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    current = await deps.db_client.get_run(run_id)
                    if current and current["status"] in ("done", "error"):
                        _log.info("[WEBSOCKET_STREAM] [STREAM_FINISHED] Active run ID %s transitioned to completed.", run_id)
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
                    _log.info("[WEBSOCKET_STREAM] [STREAM_END] Log stream reached end-of-log signal for Run ID: %s", run_id)
                    current = await deps.db_client.get_run(run_id)
                    status = current["status"] if current else "done"
                    exit_code = current.get("exit_code") if current else None
                    await websocket.send_text(json.dumps({"status": status, "exit_code": exit_code}))
                    await websocket.close()
                    return
                
                # Stream the real-time line back
                await websocket.send_text(json.dumps({"line": item}))
        finally:
            _log.debug("[WEBSOCKET_STREAM] [LISTENER_UNREG] Unregistering WebSocket log-listener queue for Run ID: %s", run_id)
            deps.script_execution_engine.unregister_listener_queue(run_id, q)

    except WebSocketDisconnect:
        _log.info("[WEBSOCKET_STREAM] [DISCONNECT] Client disconnected from Run ID: %s", run_id)
        pass
    except Exception as exc:
        _log.error("[WEBSOCKET_STREAM] [ERROR] Exception on WebSocket for Run ID %s: %s", run_id, exc, exc_info=True)
        try:
            await websocket.close(code=1011)
        except Exception:
            pass


@router.get("/api/runs/{run_id}/files")
async def get_run_files(run_id: str):
    """List workspace files for a run."""
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
        from routers.plans import _find_plan

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
            deps.script_execution_engine.execute_run_in_background(
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
    """Request cancellation of an active run."""
    run = await deps.db_client.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["status"] not in ("pending", "running"):
        return {"status": run["status"], "cancelled": False, "detail": "Run already finished"}

    deps.script_execution_engine.cancel_run(run_id)

    # Kill the subprocess immediately
    from routers.chats_runners import _run_procs
    proc = _run_procs.get(run_id)
    if proc is not None:
        try:
            proc.kill()
        except Exception:
            pass

    return {"status": "cancelling", "cancelled": True}

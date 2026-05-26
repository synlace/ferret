import asyncio
import json
import logging
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel, Field

import deps
from routers.chats_runners_models import RunnerHeartbeat
from routers.plans import _find_plan
from services.script_execution_engine import _extract_domain, _container_workspace_path

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/runners", tags=["runners"])


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class CreateKeyRequest(BaseModel):
    name: str


class RunnerPollRequest(BaseModel):
    runner_id: str


class LogUploadRequest(BaseModel):
    chunk: str


class RunCompleteRequest(BaseModel):
    exit_code: int
    status: str  # "done" | "error"


# ---------------------------------------------------------------------------
# Helpers & Dependencies
# ---------------------------------------------------------------------------

def _resolve_log_path(run: dict) -> Optional[Path]:
    """Resolve the absolute log file path for a run, or None if not set."""
    run_log_path = run.get("run_log_path")
    if not run_log_path:
        return None
    return deps.WORKSPACES_DIR / run["project_id"] / run["workspace_id"] / run_log_path


async def verify_runner_key(x_runner_key: str = Header(..., alias="X-Runner-Key")):
    """Ensure the supplied unique runner subscription key is valid."""
    if not await deps.db_client.validate_runner_key(x_runner_key):
        raise HTTPException(status_code=401, detail="Invalid runner key")
    return x_runner_key


# ---------------------------------------------------------------------------
# Key Management
# ---------------------------------------------------------------------------

@router.get("/keys", response_model=List[dict])
async def list_runner_keys():
    """List all runner subscription keys."""
    return await deps.db_client.get_runner_keys()


@router.post("/keys", status_code=201)
async def generate_runner_key(body: CreateKeyRequest):
    """Generate a new unique runner subscription key."""
    key = f"fr_{secrets.token_hex(16)}"
    await deps.db_client.create_runner_key(key, body.name)
    return {"key": key, "name": body.name, "status": "active"}


@router.delete("/keys/{key}")
async def revoke_runner_key(key: str):
    """Revoke (delete) a unique runner subscription key."""
    success = await deps.db_client.delete_runner_key(key)
    if not success:
        raise HTTPException(status_code=404, detail="Key not found")
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Runner Subscription & Polling
# ---------------------------------------------------------------------------

@router.get("", response_model=List[dict])
async def list_runners():
    """List all active runners registered via keepalive heartbeats."""
    return await deps.db_client.get_active_runners(timeout_seconds=30)


@router.post("/heartbeat")
async def runner_heartbeat(data: RunnerHeartbeat, x_runner_key: Optional[str] = Header(None, alias="X-Runner-Key")):
    """Register a runner's presence and liveness status via heartbeat."""
    # Allow local development key / standard checks, but validate if a key is supplied
    if x_runner_key and not await deps.db_client.validate_runner_key(x_runner_key):
        raise HTTPException(status_code=401, detail="Invalid runner key")
    await deps.db_client.register_runner_heartbeat(data.runner_id, data.url, getattr(data, "logs", None))
    return {"status": "ok"}


@router.post("/poll")
async def poll_for_run(body: RunnerPollRequest, x_runner_key: str = Depends(verify_runner_key)):
    """Allow runners to securely poll for and atomically lease pending runs."""
    run = await deps.db_client.lease_pending_run(body.runner_id)
    if not run:
        return {"status": "idle"}

    # Retrieve associated plan details to prepare script execution payload
    plan = _find_plan(run["plan_id"])
    if not plan:
        _log.warning("Poll: plan %s not found for run %s", run["plan_id"], run["id"])
        await deps.db_client.update_run_status(
            run["id"],
            status="error",
            finished_at=datetime.utcnow(),
        )
        return {"status": "idle"}

    # Domain extraction and container workspace path resolution
    domain = _extract_domain(run["target_url"])
    container_ws = _container_workspace_path(run["project_id"], run["workspace_id"])

    # Template substitutions
    script = plan.get("prompt", "")
    script = script.replace("{{target}}", run["target_url"])
    script = script.replace("{{domain}}", domain)
    script = script.replace("{{workspace}}", container_ws)
    script = script.replace("{{workspace_id}}", run["workspace_id"])
    script = script.replace("{{session_id}}", run["id"])
    script = script.replace("{{project_id}}", run["project_id"])

    follow_on_plan_ids = run.get("follow_on_plan_ids") or []
    _first_follow_on = (follow_on_plan_ids or [""])[0]
    script = script.replace("{{follow_on_plan}}", _first_follow_on)

    interpreter = plan.get("interpreter", "bash")
    timeout_sec = int(plan.get("max_runtime_seconds", 600))

    return {
        "status": "run",
        "run_id": run["id"],
        "workspace_id": run["workspace_id"],
        "project_id": run["project_id"],
        "target_url": run["target_url"],
        "script": script,
        "interpreter": interpreter,
        "timeout": timeout_sec,
        "follow_on_plan_ids": follow_on_plan_ids,
        "follow_on_path_plan_ids": run.get("follow_on_path_plan_ids") or [],
    }


@router.post("/runs/{run_id}/log")
async def upload_run_log(
    run_id: str,
    body: LogUploadRequest,
    x_runner_key: str = Depends(verify_runner_key)
):
    """Allow active runners to stream/upload log chunks back to the workspace."""
    run = await deps.db_client.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    run_log_path = run.get("run_log_path")
    if not run_log_path:
        log_filename = f"run_{run_id[:8]}.log"
        run_log_path = f"logs/{log_filename}"
        await deps.db_client.update_run_status(run_id, status="running", run_log_path=run_log_path)

    log_abs_path = deps.WORKSPACES_DIR / run["project_id"] / run["workspace_id"] / run_log_path
    log_abs_path.parent.mkdir(parents=True, exist_ok=True)

    with log_abs_path.open("a", encoding="utf-8") as f:
        f.write(body.chunk)
        f.flush()

    # Broadcast lines to active WebSocket sessions and parse manifest discoveries
    lines = body.chunk.splitlines(keepends=True)
    for line in lines:
        deps.script_execution_engine._broadcast(run_id, line)

        stripped = line.strip()
        if stripped.startswith("[FERRET:MANIFEST]"):
            payload_str = stripped[len("[FERRET:MANIFEST]"):].strip()
            try:
                ws_spec = json.loads(payload_str)
                existing_children = await deps.db_client.get_workspaces(run["project_id"])
                seen_workspaces = {
                    ws["name"]: ws["id"]
                    for ws in existing_children
                    if ws.get("parent_id") == run["workspace_id"]
                }

                ws_name = ws_spec.get("name", "").strip()
                if ws_name:
                    if ws_name in seen_workspaces:
                        existing_ws_id = seen_workspaces[ws_name]
                        for rel_path, content in ws_spec.get("files", {}).items():
                            try:
                                target = deps.WORKSPACES_DIR / run["project_id"] / existing_ws_id / rel_path
                                target.parent.mkdir(parents=True, exist_ok=True)
                                target.write_text(str(content), encoding="utf-8")
                            except Exception as fe:
                                _log.warning("run %s: file update error: %s", run_id, fe)
                    else:
                        entry_type = ws_spec.get("type", "host")
                        entry_follow_on = (
                            run.get("follow_on_path_plan_ids") if entry_type == "path" else run.get("follow_on_plan_ids")
                        ) or []
                        asyncio.create_task(
                            deps.script_execution_engine._process_manifest_entry(
                                ws_spec=ws_spec,
                                parent_workspace_id=run["workspace_id"],
                                project_id=run["project_id"],
                                follow_on_plan_ids=entry_follow_on,
                                seen_workspaces=seen_workspaces,
                            )
                        )
            except Exception as json_err:
                _log.warning("run %s: malformed [FERRET:MANIFEST] line: %s, err: %s", run_id, stripped, json_err)

    return {"status": "ok"}


@router.post("/runs/{run_id}/complete")
async def complete_run(
    run_id: str,
    body: RunCompleteRequest,
    x_runner_key: str = Depends(verify_runner_key)
):
    """Allow active runners to submit final script exit status code and complete the run."""
    run = await deps.db_client.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    await deps.db_client.update_run_status(
        run_id,
        status=body.status,
        exit_code=body.exit_code,
        finished_at=datetime.utcnow()
    )

    # Signal WebSocket subscribers that execution is complete
    deps.script_execution_engine._broadcast(run_id, None)

    if body.exit_code == 0:
        ws_root = deps.WORKSPACES_DIR / run["project_id"] / run["workspace_id"]
        existing_children = await deps.db_client.get_workspaces(run["project_id"])
        seen_workspaces = {
            ws["name"]: ws["id"]
            for ws in existing_children
            if ws.get("parent_id") == run["workspace_id"]
        }
        await deps.script_execution_engine._process_manifest(
            ws_root,
            run["workspace_id"],
            run["project_id"],
            seen_workspaces=seen_workspaces
        )

        whatweb_json = ws_root / "notes" / "whatweb_raw.json"
        if whatweb_json.exists():
            try:
                with open(whatweb_json) as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            records = json.loads(line)
                            if isinstance(records, list) and records:
                                record = records[0]
                                http_status = record.get("http_status")
                                if http_status:
                                    await deps.db_client.update_workspace_http_status(
                                        run["workspace_id"],
                                        int(http_status)
                                    )
                        except Exception:
                            pass
            except Exception as e:
                _log.warning("run %s: error parsing whatweb_json: %s", run_id, e)

    return {"status": "ok"}

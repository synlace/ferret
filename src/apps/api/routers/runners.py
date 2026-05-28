import asyncio
import json
import logging
import secrets
import zipfile
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Header, UploadFile, File, WebSocket
from pydantic import BaseModel, Field

import deps
from routers.chats_runners_models import RunnerHeartbeat
from routers.plans import _find_plan
from services.script_execution_engine import _extract_domain, _container_workspace_path
from services.identity_registry import IdentityRegistry
from services.session_tunnel import SessionTunnel
from services.remote_shell import create_shell_session, kill_shell_session
from services.terminal_frame_broker import TerminalFrameBroker

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/runners", tags=["runners"])

identity_registry = IdentityRegistry()
session_tunnel = SessionTunnel()


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
    await identity_registry.authenticate_key(x_runner_key)
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
    return await identity_registry.get_active_identities(timeout_seconds=30)


@router.post("/heartbeat")
async def runner_heartbeat(data: RunnerHeartbeat, x_runner_key: Optional[str] = Header(None, alias="X-Runner-Key")):
    """Register a runner's presence and liveness status via heartbeat."""
    if x_runner_key:
        await identity_registry.authenticate_key(x_runner_key)
    await identity_registry.register_presence(data.runner_id, data.url, getattr(data, "logs", None))
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
    await session_tunnel.stream_log_chunk(run_id, body.chunk)
    return {"status": "ok"}


@router.post("/runs/{run_id}/workspace-archive")
async def upload_run_workspace_archive(
    run_id: str,
    file: UploadFile = File(...),
    x_runner_key: str = Depends(verify_runner_key)
):
    """Securely upload and unpack a ZIP archive of execution files generated by non-local runners."""
    run = await deps.db_client.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    # Resolve destination workspace path on the host
    ws_root = deps.WORKSPACES_DIR / run["project_id"] / run["workspace_id"]
    ws_root.mkdir(parents=True, exist_ok=True)

    # Save uploaded archive to a temporary file
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp_zip:
        content = await file.read()
        tmp_zip.write(content)
        tmp_zip_path = Path(tmp_zip.name)

    try:
        # Extract archive contents safely
        with zipfile.ZipFile(tmp_zip_path, 'r') as zip_ref:
            # Security: Protect against Zip-Slip path traversal vulnerabilities
            for member in zip_ref.namelist():
                member_path = Path(member)
                if ".." in member_path.parts or member_path.is_absolute():
                    raise HTTPException(status_code=400, detail="Invalid path inside ZIP")
            
            # Unpack into workspace directory
            zip_ref.extractall(ws_root)
            
        _log.info("Successfully extracted workspace archive for run %s into %s", run_id, ws_root)
        return {"status": "ok"}
    except Exception as e:
        _log.exception("Failed to unpack workspace archive for run %s", run_id)
        raise deps.server_error(e)
    finally:
        if tmp_zip_path.exists():
            os.unlink(tmp_zip_path)


@router.post("/runs/{run_id}/complete")
async def complete_run(
    run_id: str,
    body: RunCompleteRequest,
    x_runner_key: str = Depends(verify_runner_key)
):
    """Allow active runners to submit final script exit status code and complete the run."""
    await session_tunnel.complete_session_run(run_id, body.exit_code, body.status)
    return {"status": "ok"}


@router.websocket("/{runner_id}/shell")
async def runner_live_shell(websocket: WebSocket, runner_id: str):
    """Establish an interactive, bi-directional in-browser shell session with the specified runner."""
    await websocket.accept()
    try:
        session = create_shell_session(runner_id)
        await session.start()
        broker = TerminalFrameBroker(websocket, session)
        await broker.run()
    except Exception as e:
        _log.error(f"Failed to establish live shell for runner {runner_id}: {e}")
        try:
            await websocket.close()
        except Exception:
            pass


@router.delete("/{runner_id}/shell")
async def delete_runner_shell(runner_id: str):
    """Kills the underlying tmux session inside the specified runner to allow starting a fresh shell."""
    try:
        await kill_shell_session(runner_id)
        return {"status": "ok"}
    except Exception as e:
        _log.error(f"Failed to kill shell session for runner {runner_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

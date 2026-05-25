"""
Workspaces router — CRUD for named workspace directories.

All filesystem operations are delegated to WorkspaceService to maintain clean separation
of concerns, testability, and deep logical cohesion.
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException

import deps
from models import Workspace, WorkspaceCreate

_log = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Shared helper — used by workspaces.py, chats_crud.py, and runs.py
# ---------------------------------------------------------------------------

async def create_workspace(
    name: str,
    project_id: str,
    parent_id: Optional[str] = None,
) -> Workspace:
    """Create a workspace DB row and its root directory on disk."""
    return await deps.workspace_service.create_workspace(
        name=name,
        project_id=project_id,
        parent_id=parent_id,
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/api/workspaces")
async def list_workspaces(project_id: str = "temp"):
    """List all workspaces for a project, sorted by name with file counts."""
    try:
        workspaces = await deps.db_client.get_workspaces(project_id=project_id)
        # Sort by name so parents always precede children
        workspaces.sort(key=lambda w: w["name"])
        # Attach file counts for each workspace
        for ws in workspaces:
            ws["file_counts"] = deps.workspace_service.count_workspace_files(ws["id"], project_id)
            
            # Backfill http_status if None but whatweb_raw.json exists
            if ws.get("http_status") is None:
                ws_root = deps.workspace_service.workspaces_dir / project_id / ws["id"]
                whatweb_json = ws_root / "notes" / "whatweb_raw.json"
                if whatweb_json.exists():
                    try:
                        import json
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
                                        ws["http_status"] = int(status_code)
                                        await deps.db_client.update_workspace_http_status(ws["id"], int(status_code))
                                        break
                                except Exception:
                                    pass
                    except Exception:
                        pass
        return workspaces
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/workspaces", status_code=201)
async def create_workspace_endpoint(body: WorkspaceCreate):
    """Create a new workspace and its directory tree."""
    try:
        ws = await create_workspace(
            name=body.name,
            project_id=body.project_id,
            parent_id=body.parent_id,
        )
        result = ws.model_dump()
        result["run_count"] = 0
        result["hunt_count"] = 0
        result["file_counts"] = {}
        return result
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/workspaces/{workspace_id}")
async def get_workspace(workspace_id: str):
    """Get a single workspace by ID."""
    try:
        ws = await deps.db_client.get_workspace(workspace_id)
        if not ws:
            raise HTTPException(status_code=404, detail="Workspace not found")
        ws["file_counts"] = deps.workspace_service.count_workspace_files(workspace_id, ws.get("project_id", "temp"))
        return ws
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/workspaces/{workspace_id}/probe")
async def probe_workspace_liveness(workspace_id: str):
    """Trigger a manual liveness probe on a workspace's host/domain."""
    import asyncio
    try:
        ws = await deps.db_client.get_workspace(workspace_id)
        if not ws:
            raise HTTPException(status_code=404, detail="Workspace not found")

        await deps.db_client.update_workspace_status(workspace_id, "checking")
        asyncio.create_task(
            deps.workspace_service._run_background_liveness_probe(workspace_id, ws["name"])
        )
        return {"status": "checking"}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/workspaces/{workspace_id}/files")
async def get_workspace_files(workspace_id: str):
    """List all files in a workspace directory, grouped by subdirectory."""
    try:
        ws = await deps.db_client.get_workspace(workspace_id)
        if not ws:
            raise HTTPException(status_code=404, detail="Workspace not found")

        project_id = ws.get("project_id", "temp")
        files = deps.workspace_service.list_workspace_files(workspace_id, project_id)
        return {"files": files}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/workspaces/{workspace_id}/files/{file_path:path}")
async def read_workspace_file_endpoint(workspace_id: str, file_path: str):
    """Read the text content of a single workspace file."""
    try:
        ws = await deps.db_client.get_workspace(workspace_id)
        if not ws:
            raise HTTPException(status_code=404, detail="Workspace not found")

        project_id = ws.get("project_id", "temp")
        try:
            return deps.workspace_service.read_workspace_file(workspace_id, project_id, file_path)
        except ValueError as val_err:
            raise HTTPException(status_code=400, detail=str(val_err))
        except FileNotFoundError as fnf_err:
            raise HTTPException(status_code=404, detail=str(fnf_err))
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/workspaces/{workspace_id}", status_code=204)
async def delete_workspace_endpoint(workspace_id: str, project_id: str = "temp"):
    """Delete a workspace, its DB row (cascades to runs/hunts), and its files on disk."""
    try:
        # Retrieve workspace to get project_id if not supplied
        ws = await deps.db_client.get_workspace(workspace_id)
        if not ws:
            raise HTTPException(status_code=404, detail="Workspace not found")

        actual_project_id = ws.get("project_id", project_id)
        ok = await deps.workspace_service.delete_workspace(workspace_id, actual_project_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Workspace not found")
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)

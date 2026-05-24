"""
Workspaces router — CRUD for named workspace directories.

A Workspace is a named directory on disk (under WORKSPACES_DIR) that is shared
by one or more Runs and Hunts within a project.  It is the primary organisational
unit for a target scope (e.g. "hilton.com", "api.hilton.com").

Filesystem layout:
    {WORKSPACES_DIR}/{project_id}/{workspace_id}/
        <subdir>/    — any directory name; created on demand when files are written
        ...

Subdirectories are NOT pre-created and NOT hardcoded.  They emerge organically
from the paths of files written by runs, hunts, or the user.  The platform
treats all subdirectories uniformly — it has no knowledge of their names.

Routes
------
  GET    /api/workspaces?project_id=…          list workspaces (with file counts)
  POST   /api/workspaces                        create workspace (root dir only)
  GET    /api/workspaces/{id}                   workspace detail
  GET    /api/workspaces/{id}/files             list all files (grouped by subdir)
  GET    /api/workspaces/{id}/files/{path}      read a single file
  DELETE /api/workspaces/{id}                   delete workspace + files on disk
"""

import logging
import shutil
import uuid
from datetime import datetime
from pathlib import Path
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
    """List all workspaces for a project, sorted by name.

    Workspaces are returned sorted alphabetically by name so that path-prefix
    parents always appear before their children in the list.  This allows the
    UI to build a display tree by scanning the list once: a workspace whose
    name starts with "<parent_name>/" is rendered as a child of that parent.

    Example order:
        example.com
        example.com/admin   ← child of example.com
        example.com/api     ← child of example.com
        staging.example.com ← root (different domain)
    """
    try:
        workspaces = await deps.db_client.get_workspaces(project_id=project_id)
        # Sort by name so parents always precede children
        workspaces.sort(key=lambda w: w["name"])
        # Attach file counts for each workspace
        for ws in workspaces:
            ws["file_counts"] = _count_workspace_files(ws["id"], project_id)
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
        ws["file_counts"] = _count_workspace_files(workspace_id, ws.get("project_id", "temp"))
        return ws
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/workspaces/{workspace_id}/files")
async def get_workspace_files(workspace_id: str):
    """List all files in a workspace directory, grouped by subdirectory.

    Subdirectories are discovered dynamically via os.walk — no hardcoded list.
    Only the first level of subdirectories is returned (depth=1 under ws_root).
    """
    try:
        ws = await deps.db_client.get_workspace(workspace_id)
        if not ws:
            raise HTTPException(status_code=404, detail="Workspace not found")

        ws_root = deps.WORKSPACES_DIR / ws.get("project_id", "temp") / workspace_id
        files = []
        if ws_root.exists():
            for subdir_path in sorted(ws_root.iterdir()):
                if not subdir_path.is_dir():
                    continue
                subdir = subdir_path.name
                for f in sorted(subdir_path.iterdir()):
                    if f.is_file():
                        files.append({
                            "path": f"{subdir}/{f.name}",
                            "subdir": subdir,
                            "name": f.name,
                            "size": f.stat().st_size,
                            "modified": f.stat().st_mtime,
                        })
        return {"files": files}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/workspaces/{workspace_id}/files/{file_path:path}")
async def read_workspace_file(workspace_id: str, file_path: str):
    """Read the text content of a single workspace file.

    Path validation uses resolve() to guard against traversal — no allowlist
    of subdir names is required.
    """
    try:
        ws = await deps.db_client.get_workspace(workspace_id)
        if not ws:
            raise HTTPException(status_code=404, detail="Workspace not found")

        ws_root = (deps.WORKSPACES_DIR / ws.get("project_id", "temp") / workspace_id).resolve()

        # Guard against path traversal — resolve and check prefix
        target = (ws_root / file_path).resolve()
        if not str(target).startswith(str(ws_root) + "/"):
            raise HTTPException(status_code=400, detail="Path traversal not allowed")

        if not target.exists() or not target.is_file():
            raise HTTPException(status_code=404, detail="File not found")

        content = target.read_text(errors="replace")
        return {
            "path": file_path,
            "content": content,
            "size": target.stat().st_size,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/workspaces/{workspace_id}", status_code=204)
async def delete_workspace(workspace_id: str, project_id: str = "temp"):
    """Delete a workspace, its DB row (cascades to runs/hunts), and its files on disk."""
    try:
        ws = await deps.db_client.get_workspace(workspace_id)
        if not ws:
            raise HTTPException(status_code=404, detail="Workspace not found")

        ok = await deps.db_client.delete_workspace(workspace_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Workspace not found")

        # Remove the directory tree from disk (non-fatal if already gone)
        ws_root = deps.WORKSPACES_DIR / ws.get("project_id", project_id) / workspace_id
        if ws_root.exists():
            try:
                shutil.rmtree(ws_root)
                _log.info("workspace directory removed: %s", ws_root)
            except Exception as exc:
                _log.warning("failed to remove workspace directory %s: %s", ws_root, exc)
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


# ---------------------------------------------------------------------------
# Internal helper
# ---------------------------------------------------------------------------

def _count_workspace_files(workspace_id: str, project_id: str) -> dict:
    """Return a dict of subdir → file count for a workspace directory.

    Subdirectories are discovered dynamically — no hardcoded list.
    """
    ws_root = deps.WORKSPACES_DIR / project_id / workspace_id
    counts: dict = {}
    if ws_root.exists():
        for subdir_path in ws_root.iterdir():
            if subdir_path.is_dir():
                counts[subdir_path.name] = sum(1 for f in subdir_path.iterdir() if f.is_file())
    return counts

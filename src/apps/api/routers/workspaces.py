"""
Workspace file management endpoints.

Each chat session (workspace) has its own directory:
  {WORKSPACES_DIR}/{project_id}/{session_id}/
    scripts/   ← one-off scripts (bash, python, etc.)
    tests/     ← pytest test files
    notes/     ← markdown notes / findings

Endpoints:
  GET    /api/workspaces/{session_id}/files          → file tree
  GET    /api/workspaces/{session_id}/files/{path}   → read file
  PUT    /api/workspaces/{session_id}/files/{path}   → write/create file
  DELETE /api/workspaces/{session_id}/files/{path}   → delete file
  POST   /api/workspaces/{session_id}/files/{path}/run → run file in lab (SSE)
"""

import asyncio
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import deps

router = APIRouter()

ALLOWED_SUBDIRS = {"scripts", "tests", "notes"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _workspace_root(session_id: str, project_id: str) -> Path:
    """Return the workspace root for a session, creating it if needed."""
    root = deps.WORKSPACES_DIR / project_id / session_id
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_path(root: Path, rel: str) -> Path:
    """Resolve *rel* under *root* and raise 400 if it escapes the root."""
    resolved = (root / rel).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Path traversal not allowed")
    return resolved


# Files / directories that should never appear in the workspace file tree.
# Covers pytest cache artefacts, Python bytecode, and common editor noise.
_IGNORE_NAMES: frozenset = frozenset({
    ".pytest_cache", "__pycache__", ".mypy_cache", ".ruff_cache",
    "CACHEDIR.TAG", "README.md", ".gitignore", "nodeids", "lastfailed",
    "stepwise",
})
_IGNORE_SUFFIXES: frozenset = frozenset({
    ".pyc", ".pyo", ".pyd",
})


def _file_tree(root: Path) -> List[dict]:
    """Return a flat list of file entries under *root*, grouped by subdir.

    Pytest cache directories (.pytest_cache, __pycache__) and their contents
    are excluded so they don't clutter the workspace file tree.
    """
    entries = []
    for subdir in sorted(ALLOWED_SUBDIRS):
        d = root / subdir
        if not d.exists():
            continue
        for p in sorted(d.rglob("*")):
            if not p.is_file():
                continue
            # Skip files inside ignored directories
            if any(part in _IGNORE_NAMES for part in p.parts):
                continue
            # Skip files with ignored names or suffixes
            if p.name in _IGNORE_NAMES or p.suffix in _IGNORE_SUFFIXES:
                continue
            rel = p.relative_to(root)
            entries.append({
                "path": str(rel),
                "subdir": subdir,
                "name": p.name,
                "size": p.stat().st_size,
                "modified_at": datetime.utcfromtimestamp(p.stat().st_mtime).isoformat(),
            })
    return entries


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class FileWrite(BaseModel):
    content: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/api/workspaces/{session_id}/files")
async def list_workspace_files(session_id: str, project_id: str = "temp"):
    """Return the file tree for a workspace."""
    session = await deps.db_client.get_chat_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Workspace not found")
    pid = session.get("project_id", project_id)
    root = _workspace_root(session_id, pid)
    return {"session_id": session_id, "files": _file_tree(root)}


@router.get("/api/workspaces/{session_id}/files/{file_path:path}")
async def read_workspace_file(session_id: str, file_path: str, project_id: str = "temp"):
    """Read the content of a workspace file."""
    session = await deps.db_client.get_chat_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Workspace not found")
    pid = session.get("project_id", project_id)
    root = _workspace_root(session_id, pid)
    path = _safe_path(root, file_path)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return {
        "path": file_path,
        "content": path.read_text(errors="replace"),
        "size": path.stat().st_size,
        "modified_at": datetime.utcfromtimestamp(path.stat().st_mtime).isoformat(),
    }


@router.put("/api/workspaces/{session_id}/files/{file_path:path}", status_code=200)
async def write_workspace_file(session_id: str, file_path: str, body: FileWrite, project_id: str = "temp"):
    """Write (create or overwrite) a workspace file."""
    session = await deps.db_client.get_chat_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Workspace not found")
    pid = session.get("project_id", project_id)
    root = _workspace_root(session_id, pid)

    # Enforce that the file lives inside an allowed subdir
    parts = Path(file_path).parts
    if not parts or parts[0] not in ALLOWED_SUBDIRS:
        raise HTTPException(
            status_code=400,
            detail=f"File must be under one of: {', '.join(sorted(ALLOWED_SUBDIRS))}",
        )

    path = _safe_path(root, file_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body.content)
    return {
        "path": file_path,
        "size": path.stat().st_size,
        "modified_at": datetime.utcfromtimestamp(path.stat().st_mtime).isoformat(),
    }


@router.delete("/api/workspaces/{session_id}/files/{file_path:path}", status_code=200)
async def delete_workspace_file(session_id: str, file_path: str, project_id: str = "temp"):
    """Delete a workspace file."""
    session = await deps.db_client.get_chat_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Workspace not found")
    pid = session.get("project_id", project_id)
    root = _workspace_root(session_id, pid)
    path = _safe_path(root, file_path)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    path.unlink()
    return {"deleted": file_path}


@router.post("/api/workspaces/{session_id}/files/{file_path:path}/run")
async def run_workspace_file(session_id: str, file_path: str, project_id: str = "temp", via_proxy: bool = False):
    """Run a workspace file inside the lab container and stream output via SSE.

    - tests/*.py  → pytest
    - scripts/*.py → python3
    - scripts/*.sh → bash
    - notes/*     → not runnable (400)
    """
    session = await deps.db_client.get_chat_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Workspace not found")
    pid = session.get("project_id", project_id)
    root = _workspace_root(session_id, pid)
    path = _safe_path(root, file_path)

    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    parts = Path(file_path).parts
    subdir = parts[0] if parts else ""

    if subdir == "notes":
        raise HTTPException(status_code=400, detail="Notes files cannot be run")

    # Build the docker exec command
    cmd = ["docker", "exec"]
    if via_proxy:
        proxy_addr = "http://api:1337"
        cmd += [
            "-e", f"HTTP_PROXY={proxy_addr}",
            "-e", f"HTTPS_PROXY={proxy_addr}",
            "-e", "FERRET_SOURCE=test",
        ]

    container_path = f"/workspaces/{pid}/{session_id}/{file_path}"

    if subdir == "tests" and file_path.endswith(".py"):
        cmd += [deps.SANDBOX_CONTAINER, "python3", "-m", "pytest", "-v", "--tb=short", container_path]
    elif file_path.endswith(".py"):
        cmd += [deps.SANDBOX_CONTAINER, "python3", container_path]
    elif file_path.endswith(".sh"):
        cmd += [deps.SANDBOX_CONTAINER, "bash", container_path]
    else:
        # Generic: try to execute directly
        cmd += [deps.SANDBOX_CONTAINER, container_path]

    run_id = str(uuid.uuid4())

    async def event_stream():
        yield f"data: {{\"run_id\": \"{run_id}\", \"status\": \"running\"}}\n\n"
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            assert proc.stdout is not None
            async for line in proc.stdout:
                text = line.decode("utf-8", errors="replace").rstrip()
                escaped = text.replace("\\", "\\\\").replace('"', '\\"')
                yield f"data: {{\"line\": \"{escaped}\"}}\n\n"
            await proc.wait()
            exit_code = proc.returncode
            status = "passed" if exit_code == 0 else "failed"
            yield f"data: {{\"run_id\": \"{run_id}\", \"status\": \"{status}\", \"exit_code\": {exit_code}}}\n\n"
        except Exception as exc:
            msg = str(exc).replace('"', '\\"')
            yield f"data: {{\"run_id\": \"{run_id}\", \"status\": \"error\", \"error\": \"{msg}\"}}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")

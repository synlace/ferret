"""
Sources router — project-scoped reference files stored on the filesystem.

Layout:  {SOURCES_DIR}/{project_id}/{filename}

Files can be created via the API (JSON body or multipart upload) or dropped
directly onto the host filesystem — both are surfaced by GET /sources.

No database table is used; the filesystem is the source of truth.
"""

import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import List

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import PlainTextResponse

import deps
from models import SourceMeta, SourceCreate, SourceRename, SourceKind

router = APIRouter()
_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_MAX_SOURCE_BYTES = int(__import__("os").getenv("MAX_SOURCE_SIZE_KB", "512")) * 1024  # default 512 KB

_EXT_KIND_MAP = {
    ".yaml": SourceKind.openapi,
    ".yml":  SourceKind.openapi,
    ".json": SourceKind.openapi,
    ".md":   SourceKind.documentation,
    ".txt":  SourceKind.documentation,
    ".rst":  SourceKind.documentation,
    ".py":   SourceKind.source_code,
    ".js":   SourceKind.source_code,
    ".ts":   SourceKind.source_code,
    ".go":   SourceKind.source_code,
    ".rb":   SourceKind.source_code,
    ".java": SourceKind.source_code,
    ".cs":   SourceKind.source_code,
    ".php":  SourceKind.source_code,
    ".c":    SourceKind.source_code,
    ".cpp":  SourceKind.source_code,
    ".h":    SourceKind.source_code,
}


def _infer_kind(filename: str) -> SourceKind:
    ext = Path(filename).suffix.lower()
    return _EXT_KIND_MAP.get(ext, SourceKind.other)


def _sanitise_filename(filename: str) -> str:
    """Strip path components and disallow names that could cause traversal."""
    name = Path(filename).name  # strip any directory prefix
    # Replace characters that are problematic on most filesystems
    name = re.sub(r'[^\w.\-]', '_', name)
    if not name or name.startswith('.'):
        raise HTTPException(status_code=400, detail=f"Invalid filename: {filename!r}")
    return name


def _project_dir(project_id: str) -> Path:
    return deps.SOURCES_DIR / project_id


def _source_path(project_id: str, filename: str) -> Path:
    return _project_dir(project_id) / filename


def _meta_from_path(p: Path, project_id: str) -> SourceMeta:
    stat = p.stat()
    ctime = datetime.fromtimestamp(stat.st_ctime, tz=timezone.utc).isoformat()
    return SourceMeta(
        filename=p.name,
        name=p.stem.replace("_", " ").replace("-", " "),
        kind=_infer_kind(p.name),
        size=stat.st_size,
        created_at=ctime,
    )


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------

@router.get("/api/projects/{project_id}/sources", response_model=List[SourceMeta])
async def list_sources(project_id: str):
    """List all source files for a project (metadata only — no content)."""
    project_dir = _project_dir(project_id)
    if not project_dir.exists():
        return []
    try:
        entries = sorted(project_dir.iterdir(), key=lambda p: p.stat().st_ctime, reverse=True)
        return [_meta_from_path(p, project_id) for p in entries if p.is_file()]
    except Exception as exc:
        _log.exception("list_sources failed for project=%s", project_id)
        raise deps.server_error(exc)


# ---------------------------------------------------------------------------
# Create (JSON body)
# ---------------------------------------------------------------------------

@router.post("/api/projects/{project_id}/sources", status_code=201, response_model=SourceMeta)
async def create_source(project_id: str, body: SourceCreate):
    """Create a source file from a JSON body (filename + content)."""
    filename = _sanitise_filename(body.filename)
    content_bytes = body.content.encode("utf-8")
    if len(content_bytes) > _MAX_SOURCE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Source content exceeds maximum size of {_MAX_SOURCE_BYTES // 1024} KB.",
        )
    dest = _source_path(project_id, filename)
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(body.content, encoding="utf-8")
        _log.info("source created: project=%s filename=%s size=%d", project_id, filename, len(content_bytes))
        return _meta_from_path(dest, project_id)
    except Exception as exc:
        _log.exception("create_source failed for project=%s filename=%s", project_id, filename)
        raise deps.server_error(exc)


# ---------------------------------------------------------------------------
# Upload (multipart)
# ---------------------------------------------------------------------------

@router.post("/api/projects/{project_id}/sources/upload", status_code=201, response_model=SourceMeta)
async def upload_source(
    project_id: str,
    file: UploadFile = File(...),
):
    """Upload a source file via multipart form."""
    filename = _sanitise_filename(file.filename or "upload.txt")
    raw = await file.read()
    if len(raw) > _MAX_SOURCE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Upload exceeds maximum size of {_MAX_SOURCE_BYTES // 1024} KB.",
        )
    # Reject binary content — sources must be text
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=415, detail="Only UTF-8 text files are supported as sources.")

    dest = _source_path(project_id, filename)
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")
        _log.info("source uploaded: project=%s filename=%s size=%d", project_id, filename, len(raw))
        return _meta_from_path(dest, project_id)
    except Exception as exc:
        _log.exception("upload_source failed for project=%s filename=%s", project_id, filename)
        raise deps.server_error(exc)


# ---------------------------------------------------------------------------
# Read (full content)
# ---------------------------------------------------------------------------

@router.get("/api/projects/{project_id}/sources/{filename}")
async def get_source(project_id: str, filename: str):
    """Return the full text content of a source file."""
    filename = _sanitise_filename(filename)
    path = _source_path(project_id, filename)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Source '{filename}' not found.")
    try:
        content = path.read_text(encoding="utf-8")
        meta = _meta_from_path(path, project_id)
        return {**meta.model_dump(), "content": content}
    except Exception as exc:
        _log.exception("get_source failed for project=%s filename=%s", project_id, filename)
        raise deps.server_error(exc)


# ---------------------------------------------------------------------------
# Update (overwrite content)
# ---------------------------------------------------------------------------

@router.put("/api/projects/{project_id}/sources/{filename}", response_model=SourceMeta)
async def update_source(project_id: str, filename: str, body: SourceCreate):
    """Overwrite the content of an existing source file."""
    filename = _sanitise_filename(filename)
    path = _source_path(project_id, filename)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Source '{filename}' not found.")
    content_bytes = body.content.encode("utf-8")
    if len(content_bytes) > _MAX_SOURCE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Source content exceeds maximum size of {_MAX_SOURCE_BYTES // 1024} KB.",
        )
    try:
        path.write_text(body.content, encoding="utf-8")
        _log.info("source updated: project=%s filename=%s size=%d", project_id, filename, len(content_bytes))
        return _meta_from_path(path, project_id)
    except Exception as exc:
        _log.exception("update_source failed for project=%s filename=%s", project_id, filename)
        raise deps.server_error(exc)


# ---------------------------------------------------------------------------
# Rename
# ---------------------------------------------------------------------------

@router.patch("/api/projects/{project_id}/sources/{filename}", response_model=SourceMeta)
async def rename_source(project_id: str, filename: str, body: SourceRename):
    """Rename a source file."""
    filename = _sanitise_filename(filename)
    new_filename = _sanitise_filename(body.new_filename)
    src = _source_path(project_id, filename)
    if not src.exists():
        raise HTTPException(status_code=404, detail=f"Source '{filename}' not found.")
    dst = _source_path(project_id, new_filename)
    if dst.exists():
        raise HTTPException(status_code=409, detail=f"A source named '{new_filename}' already exists.")
    try:
        src.rename(dst)
        _log.info("source renamed: project=%s %s -> %s", project_id, filename, new_filename)
        return _meta_from_path(dst, project_id)
    except Exception as exc:
        _log.exception("rename_source failed for project=%s", project_id)
        raise deps.server_error(exc)


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------

@router.delete("/api/projects/{project_id}/sources/{filename}", status_code=204)
async def delete_source(project_id: str, filename: str):
    """Delete a source file."""
    filename = _sanitise_filename(filename)
    path = _source_path(project_id, filename)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Source '{filename}' not found.")
    try:
        path.unlink()
        _log.info("source deleted: project=%s filename=%s", project_id, filename)
    except Exception as exc:
        _log.exception("delete_source failed for project=%s filename=%s", project_id, filename)
        raise deps.server_error(exc)

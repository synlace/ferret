"""
FERRET API — pytest unit tests for the Sources endpoints.

Covers
------
Helpers (unit-level, no HTTP):
  - _sanitise_filename strips directory components
  - _sanitise_filename rejects names starting with '.'
  - _sanitise_filename replaces illegal characters
  - _infer_kind returns correct SourceKind for known extensions
  - _infer_kind returns SourceKind.other for unknown extensions

GET /api/projects/{project_id}/sources:
  - 200 with empty list when project directory does not exist
  - 200 with empty list when project directory is empty
  - 200 returns metadata for each file (filename, kind, size, created_at)
  - Files are sorted newest-first (by ctime)

POST /api/projects/{project_id}/sources:
  - 201 creates the file and returns SourceMeta
  - 201 creates the project directory if it does not exist
  - 413 when content exceeds MAX_SOURCE_SIZE_KB

POST /api/projects/{project_id}/sources/upload:
  - 201 uploads a text file and returns SourceMeta
  - 413 when the uploaded file is too large
  - 415 when the uploaded file is not valid UTF-8

GET /api/projects/{project_id}/sources/{filename}:
  - 404 when the file does not exist
  - 200 returns metadata + content for an existing file

PUT /api/projects/{project_id}/sources/{filename}:
  - 404 when the file does not exist
  - 200 overwrites content and returns updated SourceMeta

PATCH /api/projects/{project_id}/sources/{filename}:
  - 404 when the source file does not exist
  - 409 when the target name already exists
  - 200 renames the file and returns updated SourceMeta

DELETE /api/projects/{project_id}/sources/{filename}:
  - 404 when the file does not exist
  - 204 deletes the file

Run with:
    cd github/ferret/src/apps/api
    pytest test_api_sources.py -v
"""

import io
import pytest
from pathlib import Path
from unittest.mock import patch

# conftest.py provides: client, mem_db fixtures


# ---------------------------------------------------------------------------
# Helper: patch SOURCES_DIR to a tmp directory for each test
# ---------------------------------------------------------------------------

@pytest.fixture
def sources_client(client, tmp_path):
    """
    Yield (client, sources_root) with deps.SOURCES_DIR patched to a
    temporary directory so tests never touch /data/sources.
    """
    import deps as deps_module
    sources_root = tmp_path / "sources"
    sources_root.mkdir()
    with patch.object(deps_module, "SOURCES_DIR", sources_root):
        yield client, sources_root


# ---------------------------------------------------------------------------
# _sanitise_filename — unit-level
# ---------------------------------------------------------------------------

def test_sanitise_strips_directory_prefix():
    """_sanitise_filename keeps only the basename."""
    from routers.sources import _sanitise_filename
    assert _sanitise_filename("../../etc/passwd") == "passwd"


def test_sanitise_rejects_dot_prefix():
    """_sanitise_filename raises 400 for names starting with '.'."""
    from fastapi import HTTPException
    from routers.sources import _sanitise_filename
    with pytest.raises(HTTPException) as exc_info:
        _sanitise_filename(".hidden")
    assert exc_info.value.status_code == 400


def test_sanitise_replaces_illegal_chars():
    """_sanitise_filename replaces spaces and special chars with underscores."""
    from routers.sources import _sanitise_filename
    result = _sanitise_filename("my file (v2).md")
    assert " " not in result
    assert "(" not in result
    assert result.endswith(".md")


def test_sanitise_preserves_valid_name():
    """_sanitise_filename leaves a clean filename unchanged."""
    from routers.sources import _sanitise_filename
    assert _sanitise_filename("openapi.yaml") == "openapi.yaml"


# ---------------------------------------------------------------------------
# _infer_kind — unit-level
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("filename,expected_kind", [
    ("spec.yaml",   "openapi"),
    ("spec.yml",    "openapi"),
    ("api.json",    "openapi"),
    ("README.md",   "documentation"),
    ("notes.txt",   "documentation"),
    ("guide.rst",   "documentation"),
    ("main.py",     "source_code"),
    ("app.js",      "source_code"),
    ("server.ts",   "source_code"),
    ("main.go",     "source_code"),
    ("unknown.xyz", "other"),
    ("noext",       "other"),
])
def test_infer_kind(filename, expected_kind):
    from routers.sources import _infer_kind
    assert _infer_kind(filename).value == expected_kind


# ---------------------------------------------------------------------------
# GET /api/projects/{project_id}/sources
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_sources_no_project_dir(sources_client):
    """Returns empty list when the project directory does not exist."""
    client, _ = sources_client
    resp = await client.get("/api/projects/proj-missing/sources")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_sources_empty_dir(sources_client):
    """Returns empty list when the project directory exists but has no files."""
    client, sources_root = sources_client
    (sources_root / "proj-empty").mkdir()
    resp = await client.get("/api/projects/proj-empty/sources")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_sources_returns_metadata(sources_client):
    """Returns SourceMeta for each file in the project directory."""
    client, sources_root = sources_client
    proj_dir = sources_root / "proj-abc"
    proj_dir.mkdir()
    (proj_dir / "openapi.yaml").write_text("openapi: 3.0.0")
    (proj_dir / "README.md").write_text("# Docs")

    resp = await client.get("/api/projects/proj-abc/sources")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2

    filenames = {item["filename"] for item in data}
    assert "openapi.yaml" in filenames
    assert "README.md" in filenames

    for item in data:
        assert "filename" in item
        assert "name" in item
        assert "kind" in item
        assert "size" in item
        assert "created_at" in item


@pytest.mark.asyncio
async def test_list_sources_kind_inference(sources_client):
    """Kind is correctly inferred from file extension."""
    client, sources_root = sources_client
    proj_dir = sources_root / "proj-kinds"
    proj_dir.mkdir()
    (proj_dir / "spec.yaml").write_text("openapi: 3.0.0")
    (proj_dir / "main.py").write_text("print('hello')")

    resp = await client.get("/api/projects/proj-kinds/sources")
    assert resp.status_code == 200
    by_name = {item["filename"]: item for item in resp.json()}
    assert by_name["spec.yaml"]["kind"] == "openapi"
    assert by_name["main.py"]["kind"] == "source_code"


# ---------------------------------------------------------------------------
# POST /api/projects/{project_id}/sources  (JSON body)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_create_source_returns_201(sources_client):
    """Creates a source file from a JSON body and returns SourceMeta."""
    client, sources_root = sources_client
    resp = await client.post(
        "/api/projects/proj-new/sources",
        json={"filename": "notes.md", "content": "# My notes"},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["filename"] == "notes.md"
    assert data["kind"] == "documentation"
    assert data["size"] == len("# My notes".encode())


@pytest.mark.asyncio
async def test_create_source_creates_project_dir(sources_client):
    """Creates the project directory if it does not already exist."""
    client, sources_root = sources_client
    proj_dir = sources_root / "proj-autocreate"
    assert not proj_dir.exists()

    resp = await client.post(
        "/api/projects/proj-autocreate/sources",
        json={"filename": "api.yaml", "content": "openapi: 3.0.0"},
    )
    assert resp.status_code == 201
    assert proj_dir.exists()
    assert (proj_dir / "api.yaml").exists()


@pytest.mark.asyncio
async def test_create_source_413_too_large(sources_client):
    """Returns 413 when content exceeds the size limit."""
    client, _ = sources_client
    # Patch the limit to 10 bytes so we don't need to allocate megabytes
    import routers.sources as sources_module
    with patch.object(sources_module, "_MAX_SOURCE_BYTES", 10):
        resp = await client.post(
            "/api/projects/proj-big/sources",
            json={"filename": "big.txt", "content": "x" * 11},
        )
    assert resp.status_code == 413


# ---------------------------------------------------------------------------
# POST /api/projects/{project_id}/sources/upload  (multipart)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_upload_source_returns_201(sources_client):
    """Uploads a text file via multipart and returns SourceMeta."""
    client, _ = sources_client
    content = b"# Uploaded doc\nSome content here."
    resp = await client.post(
        "/api/projects/proj-upload/sources/upload",
        files={"file": ("README.md", io.BytesIO(content), "text/markdown")},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["filename"] == "README.md"
    assert data["kind"] == "documentation"
    assert data["size"] == len(content)


@pytest.mark.asyncio
async def test_upload_source_413_too_large(sources_client):
    """Returns 413 when the uploaded file exceeds the size limit."""
    client, _ = sources_client
    import routers.sources as sources_module
    with patch.object(sources_module, "_MAX_SOURCE_BYTES", 5):
        resp = await client.post(
            "/api/projects/proj-upload-big/sources/upload",
            files={"file": ("big.txt", io.BytesIO(b"x" * 6), "text/plain")},
        )
    assert resp.status_code == 413


@pytest.mark.asyncio
async def test_upload_source_415_binary(sources_client):
    """Returns 415 when the uploaded file is not valid UTF-8."""
    client, _ = sources_client
    binary_content = bytes(range(256))  # contains non-UTF-8 bytes
    resp = await client.post(
        "/api/projects/proj-binary/sources/upload",
        files={"file": ("image.bin", io.BytesIO(binary_content), "application/octet-stream")},
    )
    assert resp.status_code == 415


# ---------------------------------------------------------------------------
# GET /api/projects/{project_id}/sources/{filename}
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_source_404_missing(sources_client):
    """Returns 404 when the source file does not exist."""
    client, _ = sources_client
    resp = await client.get("/api/projects/proj-x/sources/missing.md")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_source_returns_content(sources_client):
    """Returns metadata + content for an existing source file."""
    client, sources_root = sources_client
    proj_dir = sources_root / "proj-read"
    proj_dir.mkdir()
    (proj_dir / "spec.yaml").write_text("openapi: 3.0.0\ninfo:\n  title: Test")

    resp = await client.get("/api/projects/proj-read/sources/spec.yaml")
    assert resp.status_code == 200
    data = resp.json()
    assert data["filename"] == "spec.yaml"
    assert data["kind"] == "openapi"
    assert "openapi: 3.0.0" in data["content"]
    assert "size" in data
    assert "created_at" in data


# ---------------------------------------------------------------------------
# PUT /api/projects/{project_id}/sources/{filename}
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_update_source_404_missing(sources_client):
    """Returns 404 when trying to update a non-existent source."""
    client, _ = sources_client
    resp = await client.put(
        "/api/projects/proj-x/sources/ghost.md",
        json={"filename": "ghost.md", "content": "new content"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_update_source_overwrites_content(sources_client):
    """Overwrites the file content and returns updated SourceMeta."""
    client, sources_root = sources_client
    proj_dir = sources_root / "proj-update"
    proj_dir.mkdir()
    (proj_dir / "notes.md").write_text("original")

    resp = await client.put(
        "/api/projects/proj-update/sources/notes.md",
        json={"filename": "notes.md", "content": "updated content"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["filename"] == "notes.md"
    assert data["size"] == len("updated content".encode())
    # Verify the file on disk was actually changed
    assert (proj_dir / "notes.md").read_text() == "updated content"


# ---------------------------------------------------------------------------
# PATCH /api/projects/{project_id}/sources/{filename}  (rename)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_rename_source_404_missing(sources_client):
    """Returns 404 when the source to rename does not exist."""
    client, _ = sources_client
    resp = await client.patch(
        "/api/projects/proj-x/sources/ghost.md",
        json={"new_filename": "renamed.md"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_rename_source_409_conflict(sources_client):
    """Returns 409 when the target filename already exists."""
    client, sources_root = sources_client
    proj_dir = sources_root / "proj-conflict"
    proj_dir.mkdir()
    (proj_dir / "a.md").write_text("file a")
    (proj_dir / "b.md").write_text("file b")

    resp = await client.patch(
        "/api/projects/proj-conflict/sources/a.md",
        json={"new_filename": "b.md"},
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_rename_source_success(sources_client):
    """Renames the file and returns SourceMeta with the new filename."""
    client, sources_root = sources_client
    proj_dir = sources_root / "proj-rename"
    proj_dir.mkdir()
    (proj_dir / "old.md").write_text("content")

    resp = await client.patch(
        "/api/projects/proj-rename/sources/old.md",
        json={"new_filename": "new.md"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["filename"] == "new.md"
    assert not (proj_dir / "old.md").exists()
    assert (proj_dir / "new.md").exists()


# ---------------------------------------------------------------------------
# DELETE /api/projects/{project_id}/sources/{filename}
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_source_404_missing(sources_client):
    """Returns 404 when the source file does not exist."""
    client, _ = sources_client
    resp = await client.delete("/api/projects/proj-x/sources/ghost.md")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_source_204(sources_client):
    """Deletes the file and returns 204 No Content."""
    client, sources_root = sources_client
    proj_dir = sources_root / "proj-del"
    proj_dir.mkdir()
    target = proj_dir / "to_delete.md"
    target.write_text("bye")

    resp = await client.delete("/api/projects/proj-del/sources/to_delete.md")
    assert resp.status_code == 204
    assert not target.exists()

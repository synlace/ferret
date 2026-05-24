"""
FERRET API — pytest unit tests for hunt workspace endpoints.

Covers
------
Helpers:
  - _safe_path rejects path traversal attempts
  - _file_tree returns correct entries for a populated workspace

GET /api/hunts/{session_id}/files:
  - 404 when session does not exist
  - 200 with empty file list for a fresh workspace
  - 200 with correct entries after files are written

GET /api/hunts/{session_id}/files/{path}:
  - 404 when session does not exist
  - 404 when file does not exist
  - 200 with content for an existing file
  - 400 on path traversal attempt

PUT /api/hunts/{session_id}/files/{path}:
  - 404 when session does not exist
  - 400 when path is not under an allowed subdir
  - 400 on path traversal attempt
  - 200 creates the file and returns metadata
  - 200 overwrites an existing file
  - 200 for all 7 allowed subdirs (workspace, scripts, tests, notes, credentials, source, docs)

DELETE /api/hunts/{session_id}/files/{path}:
  - 404 when session does not exist
  - 404 when file does not exist
  - 200 deletes the file and returns {"deleted": path}

POST /api/hunts/{session_id}/files/{path}/run:
  - 404 when session does not exist
  - 404 when file does not exist
  - 400 when file is under notes/, credentials/, source/, or docs/
  - 200 streams SSE output for a scripts/*.py file
  - 200 streams SSE output for a scripts/*.sh file
  - 200 streams SSE output for a tests/*.py file (pytest)
  - 200 streams SSE output for a workspace/*.py file (runs like scripts)

POST /api/hunts/{session_id}/files/{path}/move:
  - 404 when session does not exist
  - 404 when source file does not exist
  - 400 when source is not under an allowed subdir
  - 400 when destination is not under an allowed subdir
  - 200 moves file and returns new path metadata
  - 200 promotes workspace/ file to scripts/

POST /api/hunts (hunt creation):
  - Creates all 7 workspace subdirectories on the filesystem
  - Returns workspace_dir in the response

Run with:
    cd github/ferret/src/apps/api
    pytest test_api_hunts.py -v
"""

import uuid
import pytest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# conftest.py provides: client, mem_db fixtures


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _create_session(client, name: str = "Test Workspace", scope: str = "blank") -> dict:
    """Create a chat session via the API and return the response JSON."""
    resp = await client.post("/api/hunts", json={"name": name, "scope": scope})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _write_file(client, session_id: str, file_path: str, content: str = "# hello") -> dict:
    """Write a file to a hunt workspace via the API and return the response JSON."""
    resp = await client.put(
        f"/api/hunts/{session_id}/files/{file_path}",
        json={"content": content},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# _safe_path helper (unit-level, no HTTP)
# ---------------------------------------------------------------------------

def test_safe_path_allows_valid_path(tmp_path):
    """_safe_path returns the resolved path for a valid relative path."""
    from routers.hunts import _safe_path
    result = _safe_path(tmp_path, "scripts/test.py")
    assert result == (tmp_path / "scripts" / "test.py").resolve()


def test_safe_path_rejects_traversal(tmp_path):
    """_safe_path raises 400 for a path that escapes the root."""
    from fastapi import HTTPException
    from routers.hunts import _safe_path
    with pytest.raises(HTTPException) as exc_info:
        _safe_path(tmp_path, "../../etc/passwd")
    assert exc_info.value.status_code == 400
    assert "traversal" in exc_info.value.detail.lower()


# ---------------------------------------------------------------------------
# _file_tree helper (unit-level, no HTTP)
# ---------------------------------------------------------------------------

def test_file_tree_empty_workspace(tmp_path):
    """_file_tree returns an empty list when no subdirs exist."""
    from routers.hunts import _file_tree
    assert _file_tree(tmp_path) == []


def test_file_tree_returns_entries(tmp_path):
    """_file_tree returns correct entries for a populated workspace."""
    from routers.hunts import _file_tree
    (tmp_path / "scripts").mkdir()
    (tmp_path / "tests").mkdir()
    (tmp_path / "notes").mkdir()
    (tmp_path / "scripts" / "recon.sh").write_text("#!/bin/bash\necho hi")
    (tmp_path / "tests" / "test_auth.py").write_text("def test_pass(): pass")
    (tmp_path / "notes" / "findings.md").write_text("# Findings")

    entries = _file_tree(tmp_path)
    paths = [e["path"] for e in entries]

    assert "notes/findings.md" in paths
    assert "scripts/recon.sh" in paths
    assert "tests/test_auth.py" in paths
    assert len(entries) == 3

    # Each entry has required fields
    for entry in entries:
        assert "path" in entry
        assert "subdir" in entry
        assert "name" in entry
        assert "size" in entry
        assert "modified_at" in entry


def test_file_tree_ignores_unknown_subdirs(tmp_path):
    """_file_tree only returns files under scripts/, tests/, notes/."""
    from routers.hunts import _file_tree
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "run.sh").write_text("echo hi")
    (tmp_path / "hidden").mkdir()
    (tmp_path / "hidden" / "secret.txt").write_text("secret")

    entries = _file_tree(tmp_path)
    paths = [e["path"] for e in entries]
    assert "scripts/run.sh" in paths
    assert "hidden/secret.txt" not in paths


# ---------------------------------------------------------------------------
# GET /api/hunts/{session_id}/files
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_files_session_not_found(client):
    """GET /api/hunts/{id}/files → 404 when session does not exist."""
    resp = await client.get("/api/hunts/nonexistent-session/files")
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_list_files_empty_workspace(client, tmp_path):
    """GET /api/hunts/{id}/files → 200 with empty list for a fresh workspace."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        resp = await client.get(f"/api/hunts/{session['id']}/files")
    assert resp.status_code == 200
    data = resp.json()
    assert data["session_id"] == session["id"]
    assert data["files"] == []


@pytest.mark.asyncio
async def test_list_files_with_content(client, tmp_path):
    """GET /api/hunts/{id}/files → 200 with entries after writing files."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        await _write_file(client, sid, "scripts/recon.sh", "#!/bin/bash\necho hi")
        await _write_file(client, sid, "tests/test_auth.py", "def test_pass(): pass")

        resp = await client.get(f"/api/hunts/{sid}/files")

    assert resp.status_code == 200
    data = resp.json()
    paths = [f["path"] for f in data["files"]]
    assert "scripts/recon.sh" in paths
    assert "tests/test_auth.py" in paths


# ---------------------------------------------------------------------------
# GET /api/hunts/{session_id}/files/{path}
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_read_file_session_not_found(client):
    """GET /api/hunts/{id}/files/{path} → 404 when session does not exist."""
    resp = await client.get("/api/hunts/nonexistent/files/scripts/run.sh")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_read_file_not_found(client, tmp_path):
    """GET /api/hunts/{id}/files/{path} → 404 when file does not exist."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        resp = await client.get(f"/api/hunts/{session['id']}/files/scripts/missing.py")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_read_file_success(client, tmp_path):
    """GET /api/hunts/{id}/files/{path} → 200 with file content."""
    import deps as deps_module
    content = "print('hello from ferret')"
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        await _write_file(client, sid, "scripts/hello.py", content)
        resp = await client.get(f"/api/hunts/{sid}/files/scripts/hello.py")

    assert resp.status_code == 200
    data = resp.json()
    assert data["content"] == content
    assert data["path"] == "scripts/hello.py"
    assert "size" in data
    assert "modified_at" in data


@pytest.mark.asyncio
async def test_read_file_path_traversal(client, tmp_path):
    """GET /api/hunts/{id}/files/{path} → 400 or 404 on path traversal.

    FastAPI normalises ``../../etc/passwd`` in the URL before routing, so the
    path may never reach _safe_path.  Both 400 (explicit rejection by
    _safe_path) and 404 (path normalised away, session/file not found) are
    acceptable — the important thing is that the server does NOT return 200.
    """
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        resp = await client.get(
            f"/api/hunts/{session['id']}/files/../../etc/passwd"
        )
    assert resp.status_code in (400, 404), (
        f"Expected 400 or 404 for path traversal, got {resp.status_code}"
    )


# ---------------------------------------------------------------------------
# PUT /api/hunts/{session_id}/files/{path}
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_write_file_session_not_found(client):
    """PUT /api/hunts/{id}/files/{path} → 404 when session does not exist."""
    resp = await client.put(
        "/api/hunts/nonexistent/files/scripts/run.sh",
        json={"content": "echo hi"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_write_file_disallowed_subdir(client, tmp_path):
    """PUT /api/hunts/{id}/files/{path} → 400 when path is not under allowed subdir."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        resp = await client.put(
            f"/api/hunts/{session['id']}/files/uploads/evil.sh",
            json={"content": "rm -rf /"},
        )
    assert resp.status_code == 400
    assert "scripts" in resp.json()["detail"] or "notes" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_write_file_path_traversal(client, tmp_path):
    """PUT /api/hunts/{id}/files/{path} → 400 or 404 on path traversal.

    FastAPI normalises ``scripts/../../evil.sh`` in the URL before routing, so
    the path may never reach _safe_path.  Both 400 (explicit rejection) and
    404 (path normalised away) are acceptable — the server must NOT return 200.
    """
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        resp = await client.put(
            f"/api/hunts/{session['id']}/files/scripts/../../evil.sh",
            json={"content": "rm -rf /"},
        )
    assert resp.status_code in (400, 404), (
        f"Expected 400 or 404 for path traversal, got {resp.status_code}"
    )


@pytest.mark.asyncio
async def test_write_file_creates_file(client, tmp_path):
    """PUT /api/hunts/{id}/files/{path} → 200 creates the file."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        resp = await client.put(
            f"/api/hunts/{sid}/files/scripts/recon.sh",
            json={"content": "#!/bin/bash\nnmap -sV $TARGET"},
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["path"] == "scripts/recon.sh"
    assert "size" in data
    assert "modified_at" in data


@pytest.mark.asyncio
async def test_write_file_overwrites_existing(client, tmp_path):
    """PUT /api/hunts/{id}/files/{path} → 200 overwrites an existing file."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        await _write_file(client, sid, "notes/findings.md", "# v1")
        resp = await client.put(
            f"/api/hunts/{sid}/files/notes/findings.md",
            json={"content": "# v2 — updated"},
        )
        assert resp.status_code == 200

        # Verify content was updated
        read_resp = await client.get(f"/api/hunts/{sid}/files/notes/findings.md")
    assert read_resp.status_code == 200
    assert read_resp.json()["content"] == "# v2 — updated"


@pytest.mark.asyncio
async def test_write_file_all_allowed_subdirs(client, tmp_path):
    """PUT /api/hunts/{id}/files/{path} → 200 for all 7 allowed subdirs."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        for subdir, filename, content in [
            ("workspace",   "scratch.py",    "print('scratch')"),
            ("scripts",     "run.sh",        "#!/bin/bash\necho hi"),
            ("tests",       "test_auth.py",  "def test_pass(): pass"),
            ("notes",       "recon.md",      "# Recon notes"),
            ("credentials", "creds.txt",     "user:pass"),
            ("source",      "app.py",        "# target source"),
            ("docs",        "readme.md",     "# Target docs"),
        ]:
            resp = await client.put(
                f"/api/hunts/{sid}/files/{subdir}/{filename}",
                json={"content": content},
            )
            assert resp.status_code == 200, f"Failed for {subdir}/{filename}: {resp.text}"


# ---------------------------------------------------------------------------
# DELETE /api/hunts/{session_id}/files/{path}
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_file_session_not_found(client):
    """DELETE /api/hunts/{id}/files/{path} → 404 when session does not exist."""
    resp = await client.delete("/api/hunts/nonexistent/files/scripts/run.sh")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_file_not_found(client, tmp_path):
    """DELETE /api/hunts/{id}/files/{path} → 404 when file does not exist."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        resp = await client.delete(
            f"/api/hunts/{session['id']}/files/scripts/missing.sh"
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_file_success(client, tmp_path):
    """DELETE /api/hunts/{id}/files/{path} → 200 deletes the file."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        await _write_file(client, sid, "scripts/temp.sh", "echo bye")

        del_resp = await client.delete(f"/api/hunts/{sid}/files/scripts/temp.sh")
        assert del_resp.status_code == 200
        assert del_resp.json()["deleted"] == "scripts/temp.sh"

        # File should no longer be readable
        read_resp = await client.get(f"/api/hunts/{sid}/files/scripts/temp.sh")
    assert read_resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_file_removed_from_tree(client, tmp_path):
    """After deletion, file no longer appears in the file tree."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        await _write_file(client, sid, "scripts/a.sh", "echo a")
        await _write_file(client, sid, "scripts/b.sh", "echo b")

        await client.delete(f"/api/hunts/{sid}/files/scripts/a.sh")
        tree_resp = await client.get(f"/api/hunts/{sid}/files")

    assert tree_resp.status_code == 200
    paths = [f["path"] for f in tree_resp.json()["files"]]
    assert "scripts/a.sh" not in paths
    assert "scripts/b.sh" in paths


# ---------------------------------------------------------------------------
# POST /api/hunts/{session_id}/files/{path}/run
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_run_file_session_not_found(client):
    """POST /api/hunts/{id}/files/{path}/run → 404 when session does not exist."""
    resp = await client.post("/api/hunts/nonexistent/files/scripts/run.sh/run")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_run_file_not_found(client, tmp_path):
    """POST /api/hunts/{id}/files/{path}/run → 404 when file does not exist."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        resp = await client.post(
            f"/api/hunts/{session['id']}/files/scripts/missing.sh/run"
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_run_notes_file_rejected(client, tmp_path):
    """POST /api/hunts/{id}/files/notes/{path}/run → 400 (notes not runnable)."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        await _write_file(client, sid, "notes/findings.md", "# Findings")
        resp = await client.post(
            f"/api/hunts/{sid}/files/notes/findings.md/run"
        )
    assert resp.status_code == 400
    assert "notes" in resp.json()["detail"].lower()


@pytest.mark.asyncio
@pytest.mark.parametrize("subdir", ["credentials", "source", "docs"])
async def test_run_non_runnable_subdirs_rejected(client, tmp_path, subdir):
    """POST /api/hunts/{id}/files/{subdir}/*.*/run → 400 for non-runnable subdirs."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        await _write_file(client, sid, f"{subdir}/file.txt", "content")
        resp = await client.post(
            f"/api/hunts/{sid}/files/{subdir}/file.txt/run"
        )
    assert resp.status_code == 400
    assert subdir in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_run_workspace_file_streams_sse(client, tmp_path):
    """POST /api/hunts/{id}/files/workspace/scratch.py/run → SSE stream (runs like scripts)."""
    import deps as deps_module

    fake_proc = MagicMock()
    fake_proc.stdout = _make_async_line_reader([b"workspace output\n"])
    fake_proc.wait = AsyncMock(return_value=None)
    fake_proc.returncode = 0

    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        await _write_file(client, sid, "workspace/scratch.py", "print('workspace output')")

        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=fake_proc)):
            resp = await client.post(f"/api/hunts/{sid}/files/workspace/scratch.py/run")

    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers["content-type"]
    body = resp.text
    assert "run_id" in body
    assert "running" in body


@pytest.mark.asyncio
async def test_run_script_py_streams_sse(client, tmp_path):
    """POST /api/hunts/{id}/files/scripts/run.py/run → SSE stream for python3."""
    import deps as deps_module

    # Mock asyncio.create_subprocess_exec to return a fake process
    fake_proc = MagicMock()
    fake_proc.stdout = _make_async_line_reader([b"hello from script\n", b"done\n"])
    fake_proc.wait = AsyncMock(return_value=None)
    fake_proc.returncode = 0

    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        await _write_file(client, sid, "scripts/run.py", "print('hello from script')")

        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=fake_proc)):
            resp = await client.post(f"/api/hunts/{sid}/files/scripts/run.py/run")

    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers["content-type"]
    # Verify the SSE payload contains a run_id and status
    body = resp.text
    assert "run_id" in body
    assert "running" in body


@pytest.mark.asyncio
async def test_run_script_sh_streams_sse(client, tmp_path):
    """POST /api/hunts/{id}/files/scripts/run.sh/run → SSE stream for bash."""
    import deps as deps_module

    fake_proc = MagicMock()
    fake_proc.stdout = _make_async_line_reader([b"output line\n"])
    fake_proc.wait = AsyncMock(return_value=None)
    fake_proc.returncode = 0

    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        await _write_file(client, sid, "scripts/run.sh", "#!/bin/bash\necho hi")

        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=fake_proc)):
            resp = await client.post(f"/api/hunts/{sid}/files/scripts/run.sh/run")

    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers["content-type"]


@pytest.mark.asyncio
async def test_run_test_py_uses_pytest(client, tmp_path):
    """POST /api/hunts/{id}/files/tests/test_auth.py/run → uses pytest command."""
    import deps as deps_module

    captured_cmd = []

    async def fake_subprocess(*args, **kwargs):
        captured_cmd.extend(args)
        proc = MagicMock()
        proc.stdout = _make_async_line_reader([b"1 passed\n"])
        proc.wait = AsyncMock(return_value=None)
        proc.returncode = 0
        return proc

    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        await _write_file(client, sid, "tests/test_auth.py", "def test_pass(): pass")

        with patch("asyncio.create_subprocess_exec", fake_subprocess):
            resp = await client.post(
                f"/api/hunts/{sid}/files/tests/test_auth.py/run"
            )

    assert resp.status_code == 200
    # The command should include pytest
    cmd_str = " ".join(str(c) for c in captured_cmd)
    assert "pytest" in cmd_str


@pytest.mark.asyncio
async def test_run_via_proxy_sets_env_vars(client, tmp_path):
    """POST .../run?via_proxy=true → docker exec includes HTTP_PROXY env vars."""
    import deps as deps_module

    captured_cmd = []

    async def fake_subprocess(*args, **kwargs):
        captured_cmd.extend(args)
        proc = MagicMock()
        proc.stdout = _make_async_line_reader([])
        proc.wait = AsyncMock(return_value=None)
        proc.returncode = 0
        return proc

    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        await _write_file(client, sid, "scripts/scan.sh", "echo hi")

        with patch("asyncio.create_subprocess_exec", fake_subprocess):
            resp = await client.post(
                f"/api/hunts/{sid}/files/scripts/scan.sh/run?via_proxy=true"
            )

    assert resp.status_code == 200
    cmd_str = " ".join(str(c) for c in captured_cmd)
    assert "HTTP_PROXY" in cmd_str or "HTTPS_PROXY" in cmd_str


# ---------------------------------------------------------------------------
# POST /api/hunts/{session_id}/files/{path}/move
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_move_file_session_not_found(client):
    """POST /api/hunts/{id}/files/{path}/move → 404 when session does not exist."""
    resp = await client.post(
        "/api/hunts/nonexistent/files/workspace/scratch.py/move",
        json={"destination": "scripts/scratch.py"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_move_file_source_not_found(client, tmp_path):
    """POST /api/hunts/{id}/files/{path}/move → 404 when source file does not exist."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        resp = await client.post(
            f"/api/hunts/{session['id']}/files/workspace/missing.py/move",
            json={"destination": "scripts/missing.py"},
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_move_file_invalid_source_subdir(client, tmp_path):
    """POST /api/hunts/{id}/files/{path}/move → 400 when source is not under allowed subdir."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        resp = await client.post(
            f"/api/hunts/{session['id']}/files/hidden/secret.py/move",
            json={"destination": "scripts/secret.py"},
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_move_file_invalid_destination_subdir(client, tmp_path):
    """POST /api/hunts/{id}/files/{path}/move → 400 when destination is not under allowed subdir."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        await _write_file(client, sid, "workspace/scratch.py", "print('hi')")
        resp = await client.post(
            f"/api/hunts/{sid}/files/workspace/scratch.py/move",
            json={"destination": "hidden/scratch.py"},
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_move_file_promotes_workspace_to_scripts(client, tmp_path):
    """POST /api/hunts/{id}/files/workspace/scratch.py/move → 200 promotes to scripts/."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        content = "print('promoted script')"
        await _write_file(client, sid, "workspace/scratch.py", content)

        resp = await client.post(
            f"/api/hunts/{sid}/files/workspace/scratch.py/move",
            json={"destination": "scripts/scratch.py"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["moved_from"] == "workspace/scratch.py"
        assert data["moved_to"] == "scripts/scratch.py"
        assert "size" in data

        # Source should be gone
        src_resp = await client.get(f"/api/hunts/{sid}/files/workspace/scratch.py")
        assert src_resp.status_code == 404

        # Destination should exist with same content
        dst_resp = await client.get(f"/api/hunts/{sid}/files/scripts/scratch.py")
        assert dst_resp.status_code == 200
        assert dst_resp.json()["content"] == content


@pytest.mark.asyncio
async def test_move_file_promotes_workspace_to_tests(client, tmp_path):
    """POST /api/hunts/{id}/files/workspace/test_foo.py/move → 200 promotes to tests/."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session = await _create_session(client)
        sid = session["id"]
        content = "def test_foo(): pass"
        await _write_file(client, sid, "workspace/test_foo.py", content)

        resp = await client.post(
            f"/api/hunts/{sid}/files/workspace/test_foo.py/move",
            json={"destination": "tests/test_foo.py"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["moved_from"] == "workspace/test_foo.py"
        assert data["moved_to"] == "tests/test_foo.py"


# ---------------------------------------------------------------------------
# POST /api/hunts — workspace directory creation
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_create_chat_creates_workspace_dirs(client, tmp_path):
    """POST /api/hunts creates the workspace root directory."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        resp = await client.post("/api/hunts", json={"name": "My Workspace"})

    assert resp.status_code == 201
    data = resp.json()
    assert "workspace_dir" in data
    assert data["workspace_dir"] is not None

    # Verify the workspace root directory was created
    workspace_root = tmp_path / data["workspace_dir"]
    assert workspace_root.is_dir(), "Workspace root was not created"


@pytest.mark.asyncio
async def test_create_chat_workspace_dir_format(client, tmp_path):
    """POST /api/hunts → workspace_dir is '{project_id}/{session_id}'."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        resp = await client.post(
            "/api/hunts?project_id=temp",
            json={"name": "Workspace Format Test"},
        )

    assert resp.status_code == 201
    data = resp.json()
    workspace_dir = data["workspace_dir"]
    parts = workspace_dir.split("/")
    assert len(parts) == 2
    assert parts[0] == "temp"
    # Second part should be a valid UUID
    assert len(parts[1]) == 36  # UUID length


# ---------------------------------------------------------------------------
# Async line reader helper for mocking subprocess stdout
# ---------------------------------------------------------------------------

class _AsyncLineReader:
    """Async iterator that yields pre-defined lines."""
    def __init__(self, lines):
        self._lines = iter(lines)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._lines)
        except StopIteration:
            raise StopAsyncIteration


def _make_async_line_reader(lines):
    return _AsyncLineReader(lines)


# ---------------------------------------------------------------------------
# Unit tests — execute_tool_call: write_note, write_credential, auto-promote
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_write_note_creates_file(tmp_path):
    """write_note tool creates a .md file in notes/ subdir."""
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "routers"))
    import deps as deps_module
    from chats_execute import execute_tool_call

    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session_id = "test-session-note"
        (tmp_path / "temp" / session_id / "notes").mkdir(parents=True, exist_ok=True)
        tc = {
            "function": {
                "name": "write_note",
                "arguments": '{"filename": "recon_summary.md", "content": "# Recon\\nFound /api/admin endpoint."}',
            }
        }
        result = await execute_tool_call(tc, project_id="temp", session_id=session_id)

    assert "notes/recon_summary.md" in result
    note_path = tmp_path / "temp" / session_id / "notes" / "recon_summary.md"
    assert note_path.exists()
    assert "Found /api/admin endpoint." in note_path.read_text()


@pytest.mark.asyncio
async def test_write_note_requires_session():
    """write_note without session_id returns an error."""
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "routers"))
    from chats_execute import execute_tool_call

    tc = {
        "function": {
            "name": "write_note",
            "arguments": '{"filename": "test.md", "content": "hello"}',
        }
    }
    result = await execute_tool_call(tc, project_id="temp", session_id="")
    assert "requires an active hunt session" in result


@pytest.mark.asyncio
async def test_write_credential_creates_file(tmp_path):
    """write_credential tool creates a file in credentials/ subdir."""
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "routers"))
    import deps as deps_module
    from chats_execute import execute_tool_call

    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        session_id = "test-session-cred"
        (tmp_path / "temp" / session_id / "credentials").mkdir(parents=True, exist_ok=True)
        tc = {
            "function": {
                "name": "write_credential",
                "arguments": '{"filename": "admin_creds.txt", "content": "admin:password123"}',
            }
        }
        result = await execute_tool_call(tc, project_id="temp", session_id=session_id)

    assert "credentials/admin_creds.txt" in result
    cred_path = tmp_path / "temp" / session_id / "credentials" / "admin_creds.txt"
    assert cred_path.exists()
    assert "admin:password123" in cred_path.read_text()


@pytest.mark.asyncio
async def test_write_credential_requires_session():
    """write_credential without session_id returns an error."""
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "routers"))
    from chats_execute import execute_tool_call

    tc = {
        "function": {
            "name": "write_credential",
            "arguments": '{"filename": "creds.txt", "content": "user:pass"}',
        }
    }
    result = await execute_tool_call(tc, project_id="temp", session_id="")
    assert "requires an active hunt session" in result


def test_pytest_all_passed_detects_success():
    """_pytest_all_passed returns True for passing pytest output."""
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "routers"))
    from chats_execute import _pytest_all_passed

    passing = "test_login_sqli.py::test_sqli PASSED\n\n1 passed in 0.45s"
    assert _pytest_all_passed(passing) is True

    multi_pass = "3 passed, 1 warning in 0.12s"
    assert _pytest_all_passed(multi_pass) is True


def test_pytest_all_passed_detects_failure():
    """_pytest_all_passed returns False for failing pytest output."""
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "routers"))
    from chats_execute import _pytest_all_passed

    failing = "test_login_sqli.py::test_sqli FAILED\n\n1 failed in 0.45s"
    assert _pytest_all_passed(failing) is False

    mixed = "2 passed, 1 failed in 0.30s"
    assert _pytest_all_passed(mixed) is False

    empty = "no tests ran"
    assert _pytest_all_passed(empty) is False


@pytest.mark.asyncio
async def test_write_test_auto_promotes_on_success(tmp_path):
    """write_test auto-promotes to tests/ when pytest passes."""
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "routers"))
    import deps as deps_module
    from chats_execute import execute_tool_call

    session_id = "test-session-promote"
    ws_root = tmp_path / "temp" / session_id
    for d in ("workspace", "tests"):
        (ws_root / d).mkdir(parents=True, exist_ok=True)

    async def fake_run_pytest(path):
        return "test_login_sqli.py::test_sqli PASSED\n\n1 passed in 0.12s"

    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        with patch.object(deps_module, "run_pytest", fake_run_pytest):
            tc = {
                "function": {
                    "name": "write_test",
                    "arguments": '{"filename": "test_login_sqli.py", "code": "def test_sqli(): pass"}',
                }
            }
            result = await execute_tool_call(tc, project_id="temp", session_id=session_id)

    # File should be promoted to tests/ and removed from workspace/
    assert (ws_root / "tests" / "test_login_sqli.py").exists()
    assert not (ws_root / "workspace" / "test_login_sqli.py").exists()
    assert "promoted to tests/test_login_sqli.py" in result


@pytest.mark.asyncio
async def test_write_test_stays_in_workspace_on_failure(tmp_path):
    """write_test keeps file in workspace/ when pytest fails."""
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "routers"))
    import deps as deps_module
    from chats_execute import execute_tool_call

    session_id = "test-session-no-promote"
    ws_root = tmp_path / "temp" / session_id
    for d in ("workspace", "tests"):
        (ws_root / d).mkdir(parents=True, exist_ok=True)

    async def fake_run_pytest(path):
        return "test_login_sqli.py::test_sqli FAILED\n\n1 failed in 0.12s"

    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        with patch.object(deps_module, "run_pytest", fake_run_pytest):
            tc = {
                "function": {
                    "name": "write_test",
                    "arguments": '{"filename": "test_login_sqli.py", "code": "def test_sqli(): assert False"}',
                }
            }
            result = await execute_tool_call(tc, project_id="temp", session_id=session_id)

    # File should remain in workspace/ (not promoted)
    assert (ws_root / "workspace" / "test_login_sqli.py").exists()
    assert not (ws_root / "tests" / "test_login_sqli.py").exists()
    assert "promoted" not in result

"""
FERRET API — pytest unit tests for workspaces and runs endpoints.

Workspaces (GET /api/workspaces, POST /api/workspaces,
            GET /api/workspaces/{id}, GET /api/workspaces/{id}/files,
            DELETE /api/workspaces/{id}):
  - GET /api/workspaces → 200 with empty list for a fresh project
  - POST /api/workspaces → 201 creates workspace row + all 7 subdirs on disk
  - GET /api/workspaces → 200 lists created workspace with file_counts
  - GET /api/workspaces/{id} → 200 returns workspace detail with file_counts
  - GET /api/workspaces/{id} → 404 for unknown workspace
  - GET /api/workspaces/{id}/files → 200 with empty list for fresh workspace
  - GET /api/workspaces/{id}/files → 200 lists files after writing to subdirs
  - GET /api/workspaces/{id}/files → 404 for unknown workspace
  - DELETE /api/workspaces/{id} → 204 removes DB row and disk directory
  - DELETE /api/workspaces/{id} → 404 for unknown workspace

Runs (GET /api/runs, POST /api/runs, GET /api/runs/{id},
      DELETE /api/runs/{id}, POST /api/runs/{id}/rerun,
      GET /api/runs/{id}/files):
  - GET /api/runs → 200 with empty list for a fresh project
  - POST /api/runs → 201 creates run row linked to workspace
  - POST /api/runs → 404 when plan_id does not exist
  - POST /api/runs → 404 when workspace_id does not exist
  - GET /api/runs → 200 lists created run
  - GET /api/runs/{id} → 200 returns run detail
  - GET /api/runs/{id} → 404 for unknown run
  - DELETE /api/runs/{id} → 204 removes run row
  - DELETE /api/runs/{id} → 404 for unknown run
  - GET /api/runs/{id}/files → 200 with empty list for fresh workspace
  - GET /api/runs/{id}/files → 200 lists files after writing to workspace subdirs
  - GET /api/runs/{id}/files → 404 for unknown run
  - POST /api/runs/{id}/rerun → 201 creates new run with same plan/target/workspace
  - POST /api/runs/{id}/rerun → 404 for unknown run
"""

import pytest
import pytest_asyncio
from unittest.mock import patch, AsyncMock, MagicMock
from pathlib import Path


# ---------------------------------------------------------------------------
# A minimal fake script plan returned by _find_plan in run tests
# ---------------------------------------------------------------------------
_FAKE_SCRIPT_PLAN = {
    "id": "subdomain_enum",
    "name": "Subdomain Enumeration",
    "tool": "script",
    "interpreter": "bash",
    "script_path": "/app/plans/scripts/subdomain_enum.sh",
    "max_runtime_seconds": 300,
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _create_workspace(client, tmp_path, name="test.example.com", project_id="temp"):
    """Create a workspace via the API (with WORKSPACES_DIR patched) and return JSON."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        resp = await client.post(
            "/api/workspaces",
            json={"name": name, "project_id": project_id},
        )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _create_run(client, tmp_path, workspace_id: str, plan_id="subdomain_enum",
                      target_url="https://test.example.com", project_id="temp"):
    """Create a run via the API (with WORKSPACES_DIR + _find_plan patched) and return response."""
    import deps as deps_module
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=_FAKE_SCRIPT_PLAN),
        patch("asyncio.create_task"),  # prevent background task from running
    ):
        resp = await client.post(
            "/api/runs",
            json={
                "workspace_id": workspace_id,
                "plan_id": plan_id,
                "target_url": target_url,
                "project_id": project_id,
            },
        )
    return resp


# ===========================================================================
# Workspaces — GET /api/workspaces
# ===========================================================================

@pytest.mark.asyncio
async def test_list_workspaces_empty(client, tmp_path):
    """GET /api/workspaces → 200 with empty list for a fresh project."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        resp = await client.get("/api/workspaces?project_id=temp")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_workspaces_returns_created(client, tmp_path):
    """GET /api/workspaces → 200 lists created workspace with file_counts."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        await client.post("/api/workspaces", json={"name": "hilton.com", "project_id": "temp"})
        resp = await client.get("/api/workspaces?project_id=temp")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    ws = data[0]
    assert ws["name"] == "hilton.com"
    assert ws["project_id"] == "temp"
    assert "file_counts" in ws
    assert isinstance(ws["file_counts"], dict)
    assert ws["run_count"] == 0
    assert ws["hunt_count"] == 0


# ===========================================================================
# Workspaces — POST /api/workspaces
# ===========================================================================

@pytest.mark.asyncio
async def test_create_workspace_creates_root_dir(client, tmp_path):
    """POST /api/workspaces → 201 creates the workspace root directory on disk.

    Subdirectories are no longer pre-created; they are created on demand when
    files are written into them.
    """
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        resp = await client.post(
            "/api/workspaces",
            json={"name": "scanme.sh", "project_id": "temp"},
        )
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "scanme.sh"
    assert "id" in data

    ws_root = tmp_path / "temp" / data["id"]
    assert ws_root.is_dir(), "Workspace root directory should exist"
    # No subdirs pre-created — they appear only after files are written
    assert list(ws_root.iterdir()) == [], "No subdirs should be pre-created"


@pytest.mark.asyncio
async def test_create_workspace_with_parent(client, tmp_path):
    """POST /api/workspaces with parent_id → 201 creates child workspace."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        parent = (await client.post(
            "/api/workspaces",
            json={"name": "example.com", "project_id": "temp"},
        )).json()

        child = (await client.post(
            "/api/workspaces",
            json={"name": "api.example.com", "project_id": "temp", "parent_id": parent["id"]},
        ))
    assert child.status_code == 201
    assert child.json()["parent_id"] == parent["id"]


# ===========================================================================
# Workspaces — GET /api/workspaces/{id}
# ===========================================================================

@pytest.mark.asyncio
async def test_get_workspace_detail(client, tmp_path):
    """GET /api/workspaces/{id} → 200 returns workspace detail with file_counts."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        created = (await client.post(
            "/api/workspaces",
            json={"name": "detail.example.com", "project_id": "temp"},
        )).json()
        resp = await client.get(f"/api/workspaces/{created['id']}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == created["id"]
    assert data["name"] == "detail.example.com"
    assert "file_counts" in data


@pytest.mark.asyncio
async def test_get_workspace_not_found(client, tmp_path):
    """GET /api/workspaces/{id} → 404 for unknown workspace."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        resp = await client.get("/api/workspaces/nonexistent-id")
    assert resp.status_code == 404


# ===========================================================================
# Workspaces — GET /api/workspaces/{id}/files
# ===========================================================================

@pytest.mark.asyncio
async def test_get_workspace_files_empty(client, tmp_path):
    """GET /api/workspaces/{id}/files → 200 with empty list for fresh workspace."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "files.example.com", "project_id": "temp"},
        )).json()
        resp = await client.get(f"/api/workspaces/{ws['id']}/files")
    assert resp.status_code == 200
    data = resp.json()
    assert "files" in data
    assert data["files"] == []


@pytest.mark.asyncio
async def test_get_workspace_files_lists_files(client, tmp_path):
    """GET /api/workspaces/{id}/files → 200 lists files after writing to subdirs."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "files2.example.com", "project_id": "temp"},
        )).json()
        ws_id = ws["id"]

        # Create subdirs on demand (as runs/scripts would) then write files
        ws_root = tmp_path / "temp" / ws_id
        (ws_root / "notes").mkdir(parents=True, exist_ok=True)
        (ws_root / "scripts").mkdir(parents=True, exist_ok=True)
        (ws_root / "workspace").mkdir(parents=True, exist_ok=True)
        (ws_root / "notes" / "findings.md").write_text("# Findings\n- XSS found")
        (ws_root / "scripts" / "scan.sh").write_text("#!/bin/bash\nnmap $1")
        (ws_root / "workspace" / "scratch.txt").write_text("temp notes")

        resp = await client.get(f"/api/workspaces/{ws_id}/files")

    assert resp.status_code == 200
    files = resp.json()["files"]
    assert len(files) == 3

    paths = {f["path"] for f in files}
    assert "notes/findings.md" in paths
    assert "scripts/scan.sh" in paths
    assert "workspace/scratch.txt" in paths

    # Verify file metadata
    notes_file = next(f for f in files if f["path"] == "notes/findings.md")
    assert notes_file["subdir"] == "notes"
    assert notes_file["name"] == "findings.md"
    assert notes_file["size"] > 0
    assert "modified" in notes_file


@pytest.mark.asyncio
async def test_get_workspace_files_not_found(client, tmp_path):
    """GET /api/workspaces/{id}/files → 404 for unknown workspace."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        resp = await client.get("/api/workspaces/nonexistent-id/files")
    assert resp.status_code == 404


# ===========================================================================
# Workspaces — DELETE /api/workspaces/{id}
# ===========================================================================

@pytest.mark.asyncio
async def test_delete_workspace(client, tmp_path):
    """DELETE /api/workspaces/{id} → 204 removes DB row and disk directory."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "delete.example.com", "project_id": "temp"},
        )).json()
        ws_id = ws["id"]
        ws_root = tmp_path / "temp" / ws_id
        assert ws_root.exists()

        resp = await client.delete(f"/api/workspaces/{ws_id}")
        assert resp.status_code == 204

        # Directory should be gone
        assert not ws_root.exists()

        # Should 404 on subsequent GET
        get_resp = await client.get(f"/api/workspaces/{ws_id}")
        assert get_resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_workspace_not_found(client, tmp_path):
    """DELETE /api/workspaces/{id} → 404 for unknown workspace."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        resp = await client.delete("/api/workspaces/nonexistent-id")
    assert resp.status_code == 404


# ===========================================================================
# Runs — GET /api/runs
# ===========================================================================

@pytest.mark.asyncio
async def test_list_runs_empty(client, tmp_path):
    """GET /api/runs → 200 with empty list for a fresh project."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        resp = await client.get("/api/runs?project_id=temp")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_runs_returns_created(client, tmp_path):
    """GET /api/runs → 200 lists created run."""
    import deps as deps_module
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=_FAKE_SCRIPT_PLAN),
        patch("asyncio.create_task"),
    ):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "list-runs.example.com", "project_id": "temp"},
        )).json()

        await client.post(
            "/api/runs",
            json={
                "workspace_id": ws["id"],
                "plan_id": "subdomain_enum",
                "target_url": "https://list-runs.example.com",
                "project_id": "temp",
            },
        )

        resp = await client.get("/api/runs?project_id=temp")

    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["plan_id"] == "subdomain_enum"
    assert data[0]["target_url"] == "https://list-runs.example.com"
    assert data[0]["status"] == "pending"


# ===========================================================================
# Runs — POST /api/runs
# ===========================================================================

@pytest.mark.asyncio
async def test_create_run_success(client, tmp_path):
    """POST /api/runs → 201 creates run row linked to workspace."""
    import deps as deps_module
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=_FAKE_SCRIPT_PLAN),
        patch("asyncio.create_task"),
    ):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "create-run.example.com", "project_id": "temp"},
        )).json()

        resp = await client.post(
            "/api/runs",
            json={
                "workspace_id": ws["id"],
                "plan_id": "subdomain_enum",
                "target_url": "https://create-run.example.com",
                "project_id": "temp",
            },
        )

    assert resp.status_code == 201
    data = resp.json()
    assert "id" in data
    assert data["workspace_id"] == ws["id"]
    assert data["plan_id"] == "subdomain_enum"
    assert data["target_url"] == "https://create-run.example.com"
    assert data["status"] == "pending"
    assert data["project_id"] == "temp"


@pytest.mark.asyncio
async def test_create_run_plan_not_found(client, tmp_path):
    """POST /api/runs → 404 when plan_id does not exist."""
    import deps as deps_module
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=None),
        patch("asyncio.create_task"),
    ):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "plan-404.example.com", "project_id": "temp"},
        )).json()

        resp = await client.post(
            "/api/runs",
            json={
                "workspace_id": ws["id"],
                "plan_id": "nonexistent_plan",
                "target_url": "https://plan-404.example.com",
                "project_id": "temp",
            },
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_create_run_unknown_workspace(client, tmp_path):
    """POST /api/runs → 404 when workspace_id does not exist."""
    import deps as deps_module
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=_FAKE_SCRIPT_PLAN),
        patch("asyncio.create_task"),
    ):
        resp = await client.post(
            "/api/runs",
            json={
                "workspace_id": "nonexistent-workspace-id",
                "plan_id": "subdomain_enum",
                "target_url": "https://test.example.com",
                "project_id": "temp",
            },
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_create_run_non_script_plan_rejected(client, tmp_path):
    """POST /api/runs → 400 when plan tool is not 'script'."""
    import deps as deps_module
    prompt_plan = {**_FAKE_SCRIPT_PLAN, "tool": "prompt"}
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=prompt_plan),
        patch("asyncio.create_task"),
    ):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "prompt-plan.example.com", "project_id": "temp"},
        )).json()

        resp = await client.post(
            "/api/runs",
            json={
                "workspace_id": ws["id"],
                "plan_id": "some_prompt_plan",
                "target_url": "https://prompt-plan.example.com",
                "project_id": "temp",
            },
        )
    assert resp.status_code == 400


# ===========================================================================
# Runs — GET /api/runs/{id}
# ===========================================================================

@pytest.mark.asyncio
async def test_get_run_detail(client, tmp_path):
    """GET /api/runs/{id} → 200 returns run detail."""
    import deps as deps_module
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=_FAKE_SCRIPT_PLAN),
        patch("asyncio.create_task"),
    ):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "get-run.example.com", "project_id": "temp"},
        )).json()
        run = (await client.post(
            "/api/runs",
            json={
                "workspace_id": ws["id"],
                "plan_id": "subdomain_enum",
                "target_url": "https://get-run.example.com",
                "project_id": "temp",
            },
        )).json()
        resp = await client.get(f"/api/runs/{run['id']}")

    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == run["id"]
    assert data["workspace_id"] == ws["id"]


@pytest.mark.asyncio
async def test_get_run_not_found(client, tmp_path):
    """GET /api/runs/{id} → 404 for unknown run."""
    resp = await client.get("/api/runs/nonexistent-run-id")
    assert resp.status_code == 404


# ===========================================================================
# Runs — DELETE /api/runs/{id}
# ===========================================================================

@pytest.mark.asyncio
async def test_delete_run(client, tmp_path):
    """DELETE /api/runs/{id} → 204 removes run row."""
    import deps as deps_module
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=_FAKE_SCRIPT_PLAN),
        patch("asyncio.create_task"),
    ):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "del-run.example.com", "project_id": "temp"},
        )).json()
        run = (await client.post(
            "/api/runs",
            json={
                "workspace_id": ws["id"],
                "plan_id": "subdomain_enum",
                "target_url": "https://del-run.example.com",
                "project_id": "temp",
            },
        )).json()

        resp = await client.delete(f"/api/runs/{run['id']}")
        assert resp.status_code == 204

        # Should 404 on subsequent GET
        get_resp = await client.get(f"/api/runs/{run['id']}")
        assert get_resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_run_not_found(client, tmp_path):
    """DELETE /api/runs/{id} → 404 for unknown run."""
    resp = await client.delete("/api/runs/nonexistent-run-id")
    assert resp.status_code == 404


# ===========================================================================
# Runs — GET /api/runs/{id}/files
# ===========================================================================

@pytest.mark.asyncio
async def test_get_run_files_empty(client, tmp_path):
    """GET /api/runs/{id}/files → 200 with empty list for fresh workspace."""
    import deps as deps_module
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=_FAKE_SCRIPT_PLAN),
        patch("asyncio.create_task"),
    ):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "run-files.example.com", "project_id": "temp"},
        )).json()
        run = (await client.post(
            "/api/runs",
            json={
                "workspace_id": ws["id"],
                "plan_id": "subdomain_enum",
                "target_url": "https://run-files.example.com",
                "project_id": "temp",
            },
        )).json()
        resp = await client.get(f"/api/runs/{run['id']}/files")

    assert resp.status_code == 200
    data = resp.json()
    assert "files" in data
    assert data["files"] == []


@pytest.mark.asyncio
async def test_get_run_files_lists_files(client, tmp_path):
    """GET /api/runs/{id}/files → 200 lists files after writing to workspace subdirs."""
    import deps as deps_module
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=_FAKE_SCRIPT_PLAN),
        patch("asyncio.create_task"),
    ):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "run-files2.example.com", "project_id": "temp"},
        )).json()
        ws_id = ws["id"]
        run = (await client.post(
            "/api/runs",
            json={
                "workspace_id": ws_id,
                "plan_id": "subdomain_enum",
                "target_url": "https://run-files2.example.com",
                "project_id": "temp",
            },
        )).json()

        # Create subdirs on demand then write files (mirrors what a script run does)
        ws_root = tmp_path / "temp" / ws_id
        (ws_root / "notes").mkdir(parents=True, exist_ok=True)
        (ws_root / "workspace").mkdir(parents=True, exist_ok=True)
        (ws_root / "notes" / "subdomains.txt").write_text("api.example.com\nwww.example.com")
        (ws_root / "workspace" / "output.log").write_text("scan complete")

        resp = await client.get(f"/api/runs/{run['id']}/files")

    assert resp.status_code == 200
    files = resp.json()["files"]
    assert len(files) == 2
    paths = {f["path"] for f in files}
    assert "notes/subdomains.txt" in paths
    assert "workspace/output.log" in paths


@pytest.mark.asyncio
async def test_get_run_files_not_found(client, tmp_path):
    """GET /api/runs/{id}/files → 404 for unknown run."""
    resp = await client.get("/api/runs/nonexistent-run-id/files")
    assert resp.status_code == 404


# ===========================================================================
# Runs — POST /api/runs/{id}/rerun
# ===========================================================================

@pytest.mark.asyncio
async def test_rerun_creates_new_run(client, tmp_path):
    """POST /api/runs/{id}/rerun → 201 creates new run with same plan/target/workspace."""
    import deps as deps_module
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=_FAKE_SCRIPT_PLAN),
        patch("asyncio.create_task"),
    ):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "rerun.example.com", "project_id": "temp"},
        )).json()
        original = (await client.post(
            "/api/runs",
            json={
                "workspace_id": ws["id"],
                "plan_id": "subdomain_enum",
                "target_url": "https://rerun.example.com",
                "project_id": "temp",
            },
        )).json()

        resp = await client.post(f"/api/runs/{original['id']}/rerun")

    assert resp.status_code == 201
    new_run = resp.json()
    assert new_run["id"] != original["id"]
    assert new_run["workspace_id"] == original["workspace_id"]
    assert new_run["plan_id"] == original["plan_id"]
    assert new_run["target_url"] == original["target_url"]
    assert new_run["status"] == "pending"


@pytest.mark.asyncio
async def test_rerun_not_found(client, tmp_path):
    """POST /api/runs/{id}/rerun → 404 for unknown run."""
    resp = await client.post("/api/runs/nonexistent-run-id/rerun")
    assert resp.status_code == 404


# ===========================================================================
# Runs — follow_on_plan_ids (multi-select follow-on plans)
# ===========================================================================

@pytest.mark.asyncio
async def test_create_run_with_follow_on_plan_ids(client, tmp_path):
    """POST /api/runs with follow_on_plan_ids → stored and returned as list."""
    import deps as deps_module
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=_FAKE_SCRIPT_PLAN),
        patch("asyncio.create_task"),
    ):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "follow-on.example.com", "project_id": "temp"},
        )).json()

        resp = await client.post(
            "/api/runs",
            json={
                "workspace_id": ws["id"],
                "plan_id": "subdomain_enum",
                "target_url": "https://follow-on.example.com",
                "project_id": "temp",
                "follow_on_plan_ids": ["whatweb", "subdomain_enum"],
            },
        )

    assert resp.status_code == 201
    data = resp.json()
    assert data["follow_on_plan_ids"] == ["whatweb", "subdomain_enum"]


@pytest.mark.asyncio
async def test_create_run_follow_on_plan_ids_defaults_empty(client, tmp_path):
    """POST /api/runs without follow_on_plan_ids → defaults to empty list."""
    import deps as deps_module
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=_FAKE_SCRIPT_PLAN),
        patch("asyncio.create_task"),
    ):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "no-follow-on.example.com", "project_id": "temp"},
        )).json()

        resp = await client.post(
            "/api/runs",
            json={
                "workspace_id": ws["id"],
                "plan_id": "subdomain_enum",
                "target_url": "https://no-follow-on.example.com",
                "project_id": "temp",
            },
        )

    assert resp.status_code == 201
    data = resp.json()
    assert data["follow_on_plan_ids"] == []


@pytest.mark.asyncio
async def test_rerun_preserves_follow_on_plan_ids(client, tmp_path):
    """POST /api/runs/{id}/rerun → new run inherits follow_on_plan_ids from original."""
    import deps as deps_module
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=_FAKE_SCRIPT_PLAN),
        patch("asyncio.create_task"),
    ):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "rerun-follow.example.com", "project_id": "temp"},
        )).json()
        original = (await client.post(
            "/api/runs",
            json={
                "workspace_id": ws["id"],
                "plan_id": "subdomain_enum",
                "target_url": "https://rerun-follow.example.com",
                "project_id": "temp",
                "follow_on_plan_ids": ["whatweb"],
            },
        )).json()

        resp = await client.post(f"/api/runs/{original['id']}/rerun")

    assert resp.status_code == 201
    new_run = resp.json()
    assert new_run["follow_on_plan_ids"] == ["whatweb"]


# ===========================================================================
# Workspace file_counts reflect actual files on disk
# ===========================================================================

@pytest.mark.asyncio
async def test_workspace_file_counts_reflect_disk(client, tmp_path):
    """GET /api/workspaces → file_counts accurately reflects files on disk."""
    import deps as deps_module
    with patch.object(deps_module, "WORKSPACES_DIR", tmp_path):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "counts.example.com", "project_id": "temp"},
        )).json()
        ws_id = ws["id"]
        ws_root = tmp_path / "temp" / ws_id

        # Create subdirs on demand then write files
        (ws_root / "notes").mkdir(parents=True, exist_ok=True)
        (ws_root / "scripts").mkdir(parents=True, exist_ok=True)
        (ws_root / "notes" / "a.md").write_text("note a")
        (ws_root / "notes" / "b.md").write_text("note b")
        (ws_root / "scripts" / "scan.sh").write_text("#!/bin/bash")

        resp = await client.get("/api/workspaces?project_id=temp")

    assert resp.status_code == 200
    ws_data = resp.json()[0]
    counts = ws_data["file_counts"]
    assert counts["notes"] == 2
    assert counts["scripts"] == 1
    # workspace and tests subdirs don't exist yet — not in counts dict
    assert counts.get("workspace", 0) == 0
    assert counts.get("tests", 0) == 0


# ===========================================================================
# Run count reflected in workspace list
# ===========================================================================

@pytest.mark.asyncio
async def test_workspace_run_count(client, tmp_path):
    """GET /api/workspaces → run_count reflects number of runs for workspace."""
    import deps as deps_module
    with (
        patch.object(deps_module, "WORKSPACES_DIR", tmp_path),
        patch("plans._find_plan", return_value=_FAKE_SCRIPT_PLAN),
        patch("asyncio.create_task"),
    ):
        ws = (await client.post(
            "/api/workspaces",
            json={"name": "runcount.example.com", "project_id": "temp"},
        )).json()

        # Create 2 runs for this workspace
        for i in range(2):
            await client.post(
                "/api/runs",
                json={
                    "workspace_id": ws["id"],
                    "plan_id": "subdomain_enum",
                    "target_url": f"https://target{i}.example.com",
                    "project_id": "temp",
                },
            )

        resp = await client.get("/api/workspaces?project_id=temp")

    assert resp.status_code == 200
    ws_data = resp.json()[0]
    assert ws_data["run_count"] == 2

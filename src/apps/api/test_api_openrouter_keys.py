"""
Tests for OpenRouter provisioned key management endpoints.

Covers:
  POST   /api/projects/{id}/keys  — success, missing master key (503), OR API error (502)
  GET    /api/projects/{id}/keys  — returns DB keys enriched with mocked OR usage
  DELETE /api/projects/{id}/keys/{key_id} — deletes from OR + DB
  GET    /api/projects/{id}/spend — aggregates spend, stores snapshot
"""

import asyncio
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import aiosqlite
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient, Response


# ---------------------------------------------------------------------------
# Helpers to build a minimal in-memory DB + patched app
# ---------------------------------------------------------------------------

async def _make_db():
    """Create an in-memory SQLiteClient with schema initialised."""
    from sqlite_client import SQLiteClient

    db = SQLiteClient.__new__(SQLiteClient)
    db.db_path = Path(":memory:")
    db._db = await aiosqlite.connect(":memory:")
    db._db.row_factory = aiosqlite.Row
    await db._db.execute("PRAGMA journal_mode=WAL")
    await db._db.execute("PRAGMA foreign_keys=ON")
    await db._create_schema()
    # Seed the temp project so FK constraints pass
    await db.seed_temp_project()
    return db


def _make_mitm_manager():
    mgr = MagicMock()
    mgr.start = AsyncMock()
    mgr.stop = AsyncMock()
    mgr.get_status = AsyncMock(return_value={"running": False, "port": 1337})
    mgr.get_settings = AsyncMock(return_value={})
    mgr.update_settings = AsyncMock()
    mgr.get_snare_rules = AsyncMock(return_value=[])
    mgr.add_snare_rule = AsyncMock()
    mgr.delete_snare_rule = AsyncMock()
    mgr.start_snare = AsyncMock()
    mgr.stop_snare = AsyncMock()
    mgr.send_request = AsyncMock(return_value={})
    return mgr


@asynccontextmanager
async def _noop_lifespan(app):
    yield


def _mock_httpx_response(status_code: int, json_body: dict) -> MagicMock:
    """Build a mock httpx.Response-like object."""
    resp = MagicMock(spec=Response)
    resp.status_code = status_code
    resp.json = MagicMock(return_value=json_body)
    resp.text = str(json_body)
    if status_code >= 400:
        from httpx import HTTPStatusError, Request
        req = MagicMock(spec=Request)
        resp.raise_for_status = MagicMock(
            side_effect=HTTPStatusError(
                message=f"HTTP {status_code}",
                request=req,
                response=resp,
            )
        )
    else:
        resp.raise_for_status = MagicMock()
    return resp


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def app_client():
    """Yield an (AsyncClient, db, project_id) tuple with a real project seeded."""
    import main as m
    import deps
    import routers.projects as rp

    db = await _make_db()
    mgr = _make_mitm_manager()
    m.app.router.lifespan_context = _noop_lifespan

    # Create a real project in the DB
    from models import Project
    from datetime import datetime

    project = Project(
        id=str(uuid.uuid4()),
        name="Test Project",
        description="",
        color="#f97316",
        is_temp=False,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    await db.create_project(project)

    with (
        patch.object(deps, "db_client", db),
        patch.object(deps, "mitm_manager", mgr),
        patch.object(m, "db_client", db),
        patch.object(m, "mitm_manager", mgr),
    ):
        transport = ASGITransport(app=m.app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac, db, project.id

    await db.close()


# ---------------------------------------------------------------------------
# POST /api/projects/{id}/keys
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_create_key_success(app_client):
    """Happy path: OR API returns a key, we store it and return it once."""
    ac, db, project_id = app_client

    or_response = {
        "key": "sk-or-v1-abcdefghijklmnopqrstuvwxyz1234",
        "hash": "hash-abc123",
        "name": "My Test Key",
        "limit": 10.0,
        "usage": 0.0,
        "created_at": "2024-01-01T00:00:00Z",
    }

    import routers.projects as rp

    mock_resp = _mock_httpx_response(200, or_response)
    mock_client = MagicMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch.object(rp.deps, "OPENROUTER_PROVISIONING_KEY", "master-key-xyz"), \
         patch.object(rp.httpx, "AsyncClient", return_value=mock_client):
        resp = await ac.post(
            f"/api/projects/{project_id}/keys",
            json={"name": "My Test Key", "limit_usd": 10.0},
        )

    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["key_hash"] == "hash-abc123"
    assert data["name"] == "My Test Key"
    assert data["limit_usd"] == 10.0
    assert data["key_value"] == "sk-or-v1-abcdefghijklmnopqrstuvwxyz1234"
    assert "note" in data
    # preview = first 8 chars + "..." + last 4 chars of the key
    assert data["key_preview"] == "sk-or-v1...1234"

    # Verify stored in DB (without key_value exposed)
    keys = await db.get_project_api_keys(project_id)
    assert len(keys) == 1
    assert keys[0]["key_hash"] == "hash-abc123"


@pytest.mark.asyncio
async def test_create_key_success_new_or_response_shape(app_client):
    """
    Regression: OR API now returns { "key": "sk-or-v1-...", "data": { "hash": "...", ... } }.
    The endpoint must extract key from the top level and hash from data.
    Before the fix, hash was looked up at the top level and was always empty,
    causing a 502 "missing key/hash" error.
    """
    ac, db, project_id = app_client

    # New OR response shape: key at top level, hash inside data
    or_response = {
        "key": "sk-or-v1-newshapekey1234567890abcdef",
        "data": {
            "hash": "hash-newshape-xyz",
            "name": "New Shape Key",
            "limit": 5.0,
            "usage": 0.0,
            "disabled": False,
            "created_at": "2025-01-01T00:00:00Z",
        },
    }

    import routers.projects as rp

    mock_resp = _mock_httpx_response(200, or_response)
    mock_client = MagicMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch.object(rp.deps, "OPENROUTER_PROVISIONING_KEY", "master-key-xyz"), \
         patch.object(rp.httpx, "AsyncClient", return_value=mock_client):
        resp = await ac.post(
            f"/api/projects/{project_id}/keys",
            json={"name": "New Shape Key", "limit_usd": 5.0},
        )

    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["key_hash"] == "hash-newshape-xyz", (
        f"hash must be extracted from data.hash, got: {data.get('key_hash')!r}"
    )
    assert data["key_value"] == "sk-or-v1-newshapekey1234567890abcdef"
    assert "note" in data

    # Verify stored in DB
    keys = await db.get_project_api_keys(project_id)
    assert len(keys) == 1
    assert keys[0]["key_hash"] == "hash-newshape-xyz"


@pytest.mark.asyncio
async def test_create_key_missing_master_key(app_client):
    """Returns 503 when OPENROUTER_PROVISIONING_KEY is not set."""
    ac, db, project_id = app_client

    import routers.projects as rp

    with patch.object(rp.deps, "OPENROUTER_PROVISIONING_KEY", ""):
        resp = await ac.post(
            f"/api/projects/{project_id}/keys",
            json={"name": "Key"},
        )

    assert resp.status_code == 503
    assert "OPENROUTER_PROVISIONING_KEY" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_create_key_or_api_error(app_client):
    """Returns 502 when OpenRouter API returns an error."""
    ac, db, project_id = app_client

    import routers.projects as rp
    from httpx import HTTPStatusError, Request

    error_resp = _mock_httpx_response(422, {"error": "invalid limit"})
    mock_client = MagicMock()
    mock_client.post = AsyncMock(return_value=error_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch.object(rp.deps, "OPENROUTER_PROVISIONING_KEY", "master-key-xyz"), \
         patch.object(rp.httpx, "AsyncClient", return_value=mock_client):
        resp = await ac.post(
            f"/api/projects/{project_id}/keys",
            json={"name": "Key", "limit_usd": -1.0},
        )

    assert resp.status_code == 502


@pytest.mark.asyncio
async def test_create_key_project_not_found(app_client):
    """Returns 404 for unknown project."""
    ac, db, project_id = app_client

    import routers.projects as rp

    with patch.object(rp.deps, "OPENROUTER_PROVISIONING_KEY", "master-key-xyz"):
        resp = await ac.post(
            "/api/projects/nonexistent-project/keys",
            json={"name": "Key"},
        )

    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/projects/{id}/keys
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_keys_enriched_with_usage(app_client):
    """GET returns DB keys enriched with live usage from OR (using sub-key bearer token)."""
    ac, db, project_id = app_client

    # Seed a key directly in the DB
    from models import ProjectApiKey
    from datetime import datetime

    key = ProjectApiKey(
        id=str(uuid.uuid4()),
        project_id=project_id,
        name="Seeded Key",
        key_hash="hash-seeded",
        key_preview="sk-or-v1-seed...1234",
        limit_usd=5.0,
        created_at=datetime.utcnow().isoformat(),
    )
    await db.store_project_api_key(key, "sk-or-v1-seeded-key-value")

    import routers.projects as rp

    # OR wraps the response in {"data": {...}}
    or_usage_resp = _mock_httpx_response(200, {"data": {"usage": 1.23, "limit": 5.0}})
    mock_client = MagicMock()
    mock_client.get = AsyncMock(return_value=or_usage_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch.object(rp.httpx, "AsyncClient", return_value=mock_client):
        resp = await ac.get(f"/api/projects/{project_id}/keys")

    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["key_hash"] == "hash-seeded"
    assert data[0]["usage_usd"] == 1.23


@pytest.mark.asyncio
async def test_list_keys_or_unreachable_returns_null_usage(app_client):
    """GET returns keys with usage_usd=null when OR is unreachable."""
    ac, db, project_id = app_client

    from models import ProjectApiKey
    from datetime import datetime

    key = ProjectApiKey(
        id=str(uuid.uuid4()),
        project_id=project_id,
        name="Key",
        key_hash="hash-offline",
        key_preview="sk-or-v1-offl...1234",
        limit_usd=None,
        created_at=datetime.utcnow().isoformat(),
    )
    await db.store_project_api_key(key, "sk-or-v1-offline-key")

    import routers.projects as rp

    mock_client = MagicMock()
    mock_client.get = AsyncMock(side_effect=Exception("connection refused"))
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch.object(rp.httpx, "AsyncClient", return_value=mock_client):
        resp = await ac.get(f"/api/projects/{project_id}/keys")

    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["usage_usd"] is None


@pytest.mark.asyncio
async def test_list_keys_empty(app_client):
    """GET returns empty list when no keys exist."""
    ac, db, project_id = app_client

    resp = await ac.get(f"/api/projects/{project_id}/keys")
    assert resp.status_code == 200
    assert resp.json() == []


# ---------------------------------------------------------------------------
# DELETE /api/projects/{id}/keys/{key_id}
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_key_success(app_client):
    """DELETE removes key from OR and DB."""
    ac, db, project_id = app_client

    from models import ProjectApiKey
    from datetime import datetime

    key_id = str(uuid.uuid4())
    key = ProjectApiKey(
        id=key_id,
        project_id=project_id,
        name="Key to Delete",
        key_hash="hash-to-delete",
        key_preview="sk-or-v1-dele...1234",
        limit_usd=None,
        created_at=datetime.utcnow().isoformat(),
    )
    await db.store_project_api_key(key, "sk-or-v1-delete-me")

    import routers.projects as rp

    or_delete_resp = _mock_httpx_response(200, {"deleted": True})
    mock_client = MagicMock()
    mock_client.delete = AsyncMock(return_value=or_delete_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch.object(rp.deps, "OPENROUTER_PROVISIONING_KEY", "master-key-xyz"), \
         patch.object(rp.httpx, "AsyncClient", return_value=mock_client):
        resp = await ac.delete(f"/api/projects/{project_id}/keys/{key_id}")

    assert resp.status_code == 204

    # Verify removed from DB
    keys = await db.get_project_api_keys(project_id)
    assert len(keys) == 0


@pytest.mark.asyncio
async def test_delete_key_not_found(app_client):
    """DELETE returns 404 for unknown key."""
    ac, db, project_id = app_client

    resp = await ac.delete(f"/api/projects/{project_id}/keys/nonexistent-key-id")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_key_wrong_project(app_client):
    """DELETE returns 404 when key belongs to a different project."""
    ac, db, project_id = app_client

    from models import ProjectApiKey, Project
    from datetime import datetime

    # Create a second project
    other_project = Project(
        id=str(uuid.uuid4()),
        name="Other Project",
        description="",
        color="#3b82f6",
        is_temp=False,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    await db.create_project(other_project)

    key_id = str(uuid.uuid4())
    key = ProjectApiKey(
        id=key_id,
        project_id=other_project.id,
        name="Other Key",
        key_hash="hash-other",
        key_preview="sk-or-v1-othe...1234",
        limit_usd=None,
        created_at=datetime.utcnow().isoformat(),
    )
    await db.store_project_api_key(key, "sk-or-v1-other-key")

    # Try to delete via wrong project_id
    resp = await ac.delete(f"/api/projects/{project_id}/keys/{key_id}")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/projects/{id}/spend
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_spend_aggregates_and_stores_snapshot(app_client):
    """GET /spend fetches live usage via sub-key bearer token, stores snapshots, returns totals."""
    ac, db, project_id = app_client

    from models import ProjectApiKey
    from datetime import datetime

    # Seed two keys with distinct key_values so we can distinguish OR calls by bearer token
    key_values = ["sk-or-v1-key-1", "sk-or-v1-key-2"]
    for i, (hash_, limit) in enumerate([("hash-k1", 10.0), ("hash-k2", None)]):
        key = ProjectApiKey(
            id=str(uuid.uuid4()),
            project_id=project_id,
            name=f"Key {i+1}",
            key_hash=hash_,
            key_preview=f"sk-or-v1-k{i+1}...1234",
            limit_usd=limit,
            created_at=datetime.utcnow().isoformat(),
        )
        await db.store_project_api_key(key, key_values[i])

    import routers.projects as rp

    async def mock_get(url, headers=None, **kwargs):
        # Distinguish keys by bearer token
        auth = (headers or {}).get("Authorization", "")
        if "key-1" in auth:
            return _mock_httpx_response(200, {"data": {"usage": 2.50, "limit": 10.0}})
        return _mock_httpx_response(200, {"data": {"usage": 0.75, "limit": None}})

    mock_client = MagicMock()
    mock_client.get = mock_get
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch.object(rp.httpx, "AsyncClient", return_value=mock_client):
        resp = await ac.get(f"/api/projects/{project_id}/spend")

    assert resp.status_code == 200
    data = resp.json()
    assert abs(data["total_usd"] - 3.25) < 0.001
    assert len(data["keys"]) == 2
    assert "snapshot_at" in data

    # Verify snapshots stored
    snapshots = await db.get_latest_spend_snapshots(project_id)
    assert len(snapshots) == 2
    hashes = {s["key_hash"] for s in snapshots}
    assert "hash-k1" in hashes
    assert "hash-k2" in hashes


@pytest.mark.asyncio
async def test_get_spend_no_keys(app_client):
    """GET /spend returns zero totals when project has no keys."""
    ac, db, project_id = app_client

    resp = await ac.get(f"/api/projects/{project_id}/spend")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_usd"] == 0.0
    assert data["keys"] == []


@pytest.mark.asyncio
async def test_get_spend_project_not_found(app_client):
    """GET /spend returns 404 for unknown project."""
    ac, db, project_id = app_client

    resp = await ac.get("/api/projects/nonexistent/spend")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# SQLiteClient unit tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sqlite_store_and_retrieve_key():
    """store_project_api_key / get_project_api_keys round-trip."""
    db = await _make_db()
    try:
        from models import ProjectApiKey, Project
        from datetime import datetime

        project = Project(
            id=str(uuid.uuid4()),
            name="P",
            description="",
            color="#f97316",
            is_temp=False,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        await db.create_project(project)

        key = ProjectApiKey(
            id=str(uuid.uuid4()),
            project_id=project.id,
            name="K",
            key_hash="h1",
            key_preview="sk-or-v1-abcd...5678",
            limit_usd=5.0,
            created_at=datetime.utcnow().isoformat(),
        )
        await db.store_project_api_key(key, "sk-or-v1-full-key-value")

        keys = await db.get_project_api_keys(project.id)
        assert len(keys) == 1
        assert keys[0]["key_hash"] == "h1"
        assert keys[0]["name"] == "K"
        # key_value should NOT be in the public list result
        assert "key_value" not in keys[0]

        # get_active_key_for_project returns the raw key value
        active = await db.get_active_key_for_project(project.id)
        assert active == "sk-or-v1-full-key-value"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_sqlite_delete_key():
    """delete_project_api_key removes the row."""
    db = await _make_db()
    try:
        from models import ProjectApiKey, Project
        from datetime import datetime

        project = Project(
            id=str(uuid.uuid4()),
            name="P",
            description="",
            color="#f97316",
            is_temp=False,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        await db.create_project(project)

        key_id = str(uuid.uuid4())
        key = ProjectApiKey(
            id=key_id,
            project_id=project.id,
            name="K",
            key_hash="h2",
            key_preview="sk-or-v1-abcd...5678",
            limit_usd=None,
            created_at=datetime.utcnow().isoformat(),
        )
        await db.store_project_api_key(key, "sk-or-v1-val")

        deleted = await db.delete_project_api_key(key_id)
        assert deleted is True

        keys = await db.get_project_api_keys(project.id)
        assert len(keys) == 0

        # Deleting again returns False
        deleted_again = await db.delete_project_api_key(key_id)
        assert deleted_again is False
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_sqlite_spend_snapshots():
    """store_spend_snapshot / get_latest_spend_snapshots round-trip."""
    db = await _make_db()
    try:
        project_id = "temp"
        await db.store_spend_snapshot(project_id, "hash-x", 1.0, 10.0, "2024-01-01T00:00:00")
        await db.store_spend_snapshot(project_id, "hash-x", 2.0, 10.0, "2024-01-02T00:00:00")
        await db.store_spend_snapshot(project_id, "hash-y", 0.5, None, "2024-01-01T00:00:00")

        snapshots = await db.get_latest_spend_snapshots(project_id)
        # Should return only the latest per key_hash
        assert len(snapshots) == 2
        by_hash = {s["key_hash"]: s for s in snapshots}
        assert by_hash["hash-x"]["usage_usd"] == 2.0
        assert by_hash["hash-y"]["usage_usd"] == 0.5
    finally:
        await db.close()

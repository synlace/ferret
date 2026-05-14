"""
Tests for the Projects feature — FERRET API v2.

Covers:
  1.  GET  /api/projects              — list includes temp project
  2.  POST /api/projects              — create a named project
  3.  GET  /api/projects/{id}         — get single project
  4.  PUT  /api/projects/{id}         — update name / color
  5.  DELETE /api/projects/{id}       — delete + cascade
  6.  DELETE /api/projects/temp       — blocked (400)
  7.  GET  /api/projects/{id}/export  — valid export structure
  8.  POST /api/projects/import       — new UUID, data imported
  9.  GET  /api/requests?project_id=X — only returns requests for X
  10. GET  /api/findings?project_id=X — only returns findings for X
  11. GET  /api/chats?project_id=X    — only returns chats for X
  12. GET  /api/settings/active-project — returns current active project
  13. PUT  /api/settings/active-project — updates active project
  14. PUT  /api/projects/{id} is_temp=false — promotes temp project
  15. After promoting temp, a new temp project is NOT auto-created
"""

import pytest
import pytest_asyncio
from datetime import datetime

# conftest.py provides: client, mem_db fixtures
# (same pattern as test_api_v2.py)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_request_payload(host: str = "example.com") -> dict:
    return {
        "id": __import__("uuid").uuid4().hex,
        "timestamp": datetime.utcnow().isoformat(),
        "method": "GET",
        "url": f"https://{host}/test",
        "host": host,
        "path": "/test",
        "headers": {"host": host},
        "content_length": 0,
        "intercepted": False,
        "modified": False,
        "source": "proxy",
    }


# ---------------------------------------------------------------------------
# 1. GET /api/projects — list includes temp project
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_projects_includes_temp(client, mem_db):
    """After seeding, the temp project must appear in the list."""
    await mem_db.seed_temp_project()
    resp = await client.get("/api/projects")
    assert resp.status_code == 200
    projects = resp.json()
    ids = [p["id"] for p in projects]
    assert "temp" in ids


# ---------------------------------------------------------------------------
# 2. POST /api/projects — create a named project
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_create_project(client):
    resp = await client.post("/api/projects", json={
        "name": "Alpha",
        "description": "First project",
        "color": "#ff0000",
    })
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "Alpha"
    assert data["color"] == "#ff0000"
    assert data["is_temp"] is False
    assert "id" in data


# ---------------------------------------------------------------------------
# 3. GET /api/projects/{id} — get single project
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_project(client):
    create_resp = await client.post("/api/projects", json={"name": "Beta"})
    project_id = create_resp.json()["id"]

    resp = await client.get(f"/api/projects/{project_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == project_id
    assert resp.json()["name"] == "Beta"


@pytest.mark.asyncio
async def test_get_project_not_found(client):
    resp = await client.get("/api/projects/nonexistent-id")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 4. PUT /api/projects/{id} — update name / color
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_update_project(client):
    create_resp = await client.post("/api/projects", json={"name": "Gamma"})
    project_id = create_resp.json()["id"]

    resp = await client.put(f"/api/projects/{project_id}", json={
        "name": "Gamma Updated",
        "color": "#00ff00",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "Gamma Updated"
    assert data["color"] == "#00ff00"


# ---------------------------------------------------------------------------
# 5. DELETE /api/projects/{id} — delete + cascade
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_project_cascades(client, mem_db):
    """Deleting a project removes its requests, findings, and chat sessions."""
    # Create project
    create_resp = await client.post("/api/projects", json={"name": "ToDelete"})
    project_id = create_resp.json()["id"]

    # Store a request under that project
    req = _make_request_payload("cascade.example.com")
    await mem_db.store_request(
        __import__("models").HttpRequest(**req),
        project_id=project_id,
    )

    # Store a finding under that project
    from models import Finding
    finding = Finding(
        id=__import__("uuid").uuid4().hex,
        title="Test Finding",
        host="cascade.example.com",
        created_at=datetime.utcnow(),
    )
    await mem_db.store_finding(finding, project_id=project_id)

    # Verify data exists
    reqs_before = await mem_db.search_requests(project_id=project_id)
    assert len(reqs_before) == 1
    findings_before = await mem_db.get_findings(project_id=project_id)
    assert len(findings_before) == 1

    # Delete the project
    del_resp = await client.delete(f"/api/projects/{project_id}")
    assert del_resp.status_code == 204

    # Verify cascade
    reqs_after = await mem_db.search_requests(project_id=project_id)
    assert len(reqs_after) == 0
    findings_after = await mem_db.get_findings(project_id=project_id)
    assert len(findings_after) == 0


# ---------------------------------------------------------------------------
# 6. DELETE /api/projects/temp — blocked (400)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_temp_project_blocked(client, mem_db):
    await mem_db.seed_temp_project()
    resp = await client.delete("/api/projects/temp")
    assert resp.status_code == 400
    assert "temporary" in resp.json()["detail"].lower() or "temp" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# 7. GET /api/projects/{id}/export — valid export structure
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_export_project(client, mem_db):
    await mem_db.seed_temp_project()

    # Store a request in temp
    req = _make_request_payload("export.example.com")
    from models import HttpRequest
    await mem_db.store_request(HttpRequest(**req), project_id="temp")

    resp = await client.get("/api/projects/temp/export")
    assert resp.status_code == 200
    data = resp.json()

    assert data["version"] == 1
    assert "exported_at" in data
    assert data["project"]["id"] == "temp"
    assert isinstance(data["requests"], list)
    assert isinstance(data["findings"], list)
    assert isinstance(data["chat_sessions"], list)
    assert isinstance(data["test_runs"], list)
    # The request we stored should be in the export
    assert len(data["requests"]) == 1


@pytest.mark.asyncio
async def test_export_project_not_found(client):
    resp = await client.get("/api/projects/nonexistent/export")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 8. POST /api/projects/import — new UUID, data imported
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_import_project(client, mem_db):
    await mem_db.seed_temp_project()

    # Build an export payload
    import uuid
    original_id = str(uuid.uuid4())
    req_id = str(uuid.uuid4())
    payload = {
        "version": 1,
        "exported_at": datetime.utcnow().isoformat(),
        "project": {
            "id": original_id,
            "name": "Imported Project",
            "description": "From export",
            "color": "#123456",
            "is_temp": False,
            "created_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat(),
        },
        "requests": [
            {
                "id": req_id,
                "timestamp": datetime.utcnow().isoformat(),
                "method": "POST",
                "url": "https://imported.example.com/api",
                "host": "imported.example.com",
                "path": "/api",
                "query_params": None,
                "headers": "{}",
                "body": None,
                "content_type": None,
                "content_length": 0,
                "status_code": 200,
                "response_headers": None,
                "response_body": None,
                "response_time": None,
                "response_size": None,
                "client_ip": None,
                "server_ip": None,
                "tls_version": None,
                "intercepted": 0,
                "modified": 0,
                "annotation": None,
                "source": "proxy",
                "project_id": original_id,
            }
        ],
        "findings": [],
        "chat_sessions": [],
        "test_runs": [],
    }

    resp = await client.post("/api/projects/import", json=payload)
    assert resp.status_code == 201
    data = resp.json()

    # Must have a new UUID — not the original
    assert data["id"] != original_id
    assert data["name"] == "Imported Project"

    # The imported request should exist under the new project_id
    new_id = data["id"]
    imported_reqs = await mem_db.search_requests(project_id=new_id)
    assert len(imported_reqs) == 1


# ---------------------------------------------------------------------------
# 9. GET /api/requests?project_id=X — only returns requests for X
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_requests_filtered_by_project(client, mem_db):
    await mem_db.seed_temp_project()

    # Create a second project
    create_resp = await client.post("/api/projects", json={"name": "ProjectA"})
    proj_a = create_resp.json()["id"]

    from models import HttpRequest
    # Store one request in temp, one in proj_a
    req_temp = _make_request_payload("temp.example.com")
    req_a = _make_request_payload("proja.example.com")
    await mem_db.store_request(HttpRequest(**req_temp), project_id="temp")
    await mem_db.store_request(HttpRequest(**req_a), project_id=proj_a)

    # Query for temp
    resp_temp = await client.get("/api/requests?project_id=temp")
    assert resp_temp.status_code == 200
    temp_hosts = [r["host"] for r in resp_temp.json()]
    assert "temp.example.com" in temp_hosts
    assert "proja.example.com" not in temp_hosts

    # Query for proj_a
    resp_a = await client.get(f"/api/requests?project_id={proj_a}")
    assert resp_a.status_code == 200
    a_hosts = [r["host"] for r in resp_a.json()]
    assert "proja.example.com" in a_hosts
    assert "temp.example.com" not in a_hosts


# ---------------------------------------------------------------------------
# 10. GET /api/findings?project_id=X — only returns findings for X
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_findings_filtered_by_project(client, mem_db):
    await mem_db.seed_temp_project()

    create_resp = await client.post("/api/projects", json={"name": "ProjectB"})
    proj_b = create_resp.json()["id"]

    from models import Finding
    import uuid

    f_temp = Finding(id=str(uuid.uuid4()), title="Temp Finding", host="temp.host", created_at=datetime.utcnow())
    f_b = Finding(id=str(uuid.uuid4()), title="B Finding", host="b.host", created_at=datetime.utcnow())
    await mem_db.store_finding(f_temp, project_id="temp")
    await mem_db.store_finding(f_b, project_id=proj_b)

    resp_temp = await client.get("/api/findings?project_id=temp")
    assert resp_temp.status_code == 200
    temp_titles = [f["title"] for f in resp_temp.json()]
    assert "Temp Finding" in temp_titles
    assert "B Finding" not in temp_titles

    resp_b = await client.get(f"/api/findings?project_id={proj_b}")
    assert resp_b.status_code == 200
    b_titles = [f["title"] for f in resp_b.json()]
    assert "B Finding" in b_titles
    assert "Temp Finding" not in b_titles


# ---------------------------------------------------------------------------
# 11. GET /api/chats?project_id=X — only returns chats for X
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_chats_filtered_by_project(client, mem_db):
    await mem_db.seed_temp_project()

    create_resp = await client.post("/api/projects", json={"name": "ProjectC"})
    proj_c = create_resp.json()["id"]

    # Create chat sessions via the API (project_id as query param)
    resp1 = await client.post("/api/chats?project_id=temp", json={"name": "Temp Chat"})
    assert resp1.status_code == 201

    resp2 = await client.post(f"/api/chats?project_id={proj_c}", json={"name": "C Chat"})
    assert resp2.status_code == 201

    # List chats for temp
    resp_temp = await client.get("/api/chats?project_id=temp")
    assert resp_temp.status_code == 200
    temp_names = [s["name"] for s in resp_temp.json()]
    assert "Temp Chat" in temp_names
    assert "C Chat" not in temp_names

    # List chats for proj_c
    resp_c = await client.get(f"/api/chats?project_id={proj_c}")
    assert resp_c.status_code == 200
    c_names = [s["name"] for s in resp_c.json()]
    assert "C Chat" in c_names
    assert "Temp Chat" not in c_names


# ---------------------------------------------------------------------------
# 12. GET /api/settings/active-project — returns current active project
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_active_project_default(client, mem_db):
    """With no setting stored, active project defaults to 'temp'."""
    resp = await client.get("/api/settings/active-project")
    assert resp.status_code == 200
    assert resp.json()["project_id"] == "temp"


# ---------------------------------------------------------------------------
# 13. PUT /api/settings/active-project — updates active project
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_set_active_project(client, mem_db):
    await mem_db.seed_temp_project()

    create_resp = await client.post("/api/projects", json={"name": "Active Target"})
    proj_id = create_resp.json()["id"]

    resp = await client.put("/api/settings/active-project", json={"project_id": proj_id})
    assert resp.status_code == 200
    assert resp.json()["project_id"] == proj_id

    # Verify it persisted
    get_resp = await client.get("/api/settings/active-project")
    assert get_resp.json()["project_id"] == proj_id


@pytest.mark.asyncio
async def test_set_active_project_nonexistent(client):
    """Setting active project to a non-existent ID returns 404."""
    resp = await client.put("/api/settings/active-project", json={"project_id": "does-not-exist"})
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 14. PUT /api/projects/{id} with is_temp=false — promotes temp project
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_promote_temp_project(client, mem_db):
    """Updating is_temp=false on the temp project promotes it to a named project."""
    await mem_db.seed_temp_project()

    resp = await client.put("/api/projects/temp", json={
        "name": "My Real Project",
        "is_temp": False,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "My Real Project"
    assert data["is_temp"] is False


# ---------------------------------------------------------------------------
# 15. After promoting temp, a new temp project is NOT auto-created
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_no_auto_temp_after_promote(client, mem_db):
    """
    After promoting the temp project, listing projects should NOT show a new
    auto-created temp project — seed_temp_project uses INSERT OR IGNORE so it
    won't recreate it once the row exists (even if is_temp was changed).
    """
    await mem_db.seed_temp_project()

    # Promote temp
    await client.put("/api/projects/temp", json={"name": "Promoted", "is_temp": False})

    # Call seed again (simulating a restart)
    await mem_db.seed_temp_project()

    # The 'temp' row should still exist (INSERT OR IGNORE) but with the promoted name
    project = await mem_db.get_project("temp")
    assert project is not None
    # is_temp was set to False by the promote step; seed_temp_project does not overwrite
    assert project["name"] == "Promoted"
    assert project["is_temp"] is False

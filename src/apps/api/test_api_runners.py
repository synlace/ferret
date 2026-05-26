"""
Unit and integration tests for Ferret Multiple Runners subscriptions, keys management, and secure polling.
"""

import pytest
from datetime import datetime, timezone, timedelta
from routers.chats_runners_models import RunnerHeartbeat
from models import Run

@pytest.mark.asyncio
async def test_runners_register_heartbeat_and_list(client, mem_db):
    # Verify we start with no active runners
    resp = await client.get("/api/runners")
    assert resp.status_code == 200
    assert resp.json() == []

    # Register a runner via heartbeat
    resp = await client.post("/api/runners/heartbeat", json={"runner_id": "ferret-lab-test-1", "url": "http://ferret-lab-test-1:8080"})
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}

    # Get active runners list
    resp = await client.get("/api/runners")
    assert resp.status_code == 200
    runners = resp.json()
    assert len(runners) == 1
    assert runners[0]["id"] == "ferret-lab-test-1"
    assert runners[0]["url"] == "http://ferret-lab-test-1:8080"
    assert runners[0]["status"] == "active"

@pytest.mark.asyncio
async def test_runners_offline_timeout(client, mem_db):
    # Register a runner
    await client.post("/api/runners/heartbeat", json={"runner_id": "ferret-lab-temp", "url": None})

    # Forcibly backdate heartbeat to simulate offline status
    await mem_db._db.execute(
        "UPDATE runners SET last_heartbeat = ? WHERE id = ?",
        ((datetime.utcnow() - timedelta(seconds=60)).isoformat(), "ferret-lab-temp")
    )
    await mem_db._db.commit()

    # List active runners — should be empty due to timeout
    resp = await client.get("/api/runners")
    assert resp.status_code == 200
    assert resp.json() == []

@pytest.mark.asyncio
async def test_runner_keys_crud_and_auth(client, mem_db):
    # List keys — should have the pre-seeded default dev key
    resp = await client.get("/api/runners/keys")
    assert resp.status_code == 200
    keys = resp.json()
    assert len(keys) == 1
    assert keys[0]["key"] == "fr_local_dev_key_default_33794b"
    assert keys[0]["name"] == "Default Local Runner"

    # Create a new unique runner key
    resp = await client.post("/api/runners/keys", json={"name": "Production remote runner"})
    assert resp.status_code == 201
    data = resp.json()
    assert "key" in data
    assert data["name"] == "Production remote runner"
    new_key = data["key"]

    # Verify both keys now exist
    resp = await client.get("/api/runners/keys")
    assert len(resp.json()) == 2

    # Verify authorization check with invalid key
    resp = await client.post("/api/runners/poll", json={"runner_id": "r1"}, headers={"X-Runner-Key": "invalid_key"})
    assert resp.status_code == 401

    # Verify authorization with valid pre-seeded or newly created key
    resp = await client.post("/api/runners/poll", json={"runner_id": "r1"}, headers={"X-Runner-Key": new_key})
    assert resp.status_code == 200
    # No pending run, should return status: idle
    assert resp.json() == {"status": "idle"}

    # Revoke (delete) the key
    resp = await client.delete(f"/api/runners/keys/{new_key}")
    assert resp.status_code == 200

    # Key should be deleted
    resp = await client.get("/api/runners/keys")
    assert len(resp.json()) == 1

@pytest.mark.asyncio
async def test_runner_pull_polling_execution_flow(client, mem_db, tmp_path):
    # Pre-seed a project and workspace
    now = datetime.now(timezone.utc)
    await mem_db._db.execute(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('temp', 'temp', ?, ?)",
        (now.isoformat(), now.isoformat())
    )
    await mem_db._db.execute(
        "INSERT INTO workspaces (id, project_id, name, created_at) VALUES ('ws1', 'temp', 'ws1', ?)",
        (now.isoformat(),)
    )
    await mem_db._db.commit()
    # Create a pending run
    run = Run(
        id="run-1",
        workspace_id="ws1",
        project_id="temp",
        plan_id="builtin:whatweb", # builtin plan
        target_url="http://example.com",
        status="pending",
        created_at=datetime.utcnow()
    )
    await mem_db.create_run(run)

    # Use default local dev key to poll and lease the run
    resp = await client.post(
        "/api/runners/poll",
        json={"runner_id": "local-runner-1"},
        headers={"X-Runner-Key": "fr_local_dev_key_default_33794b"}
    )
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["status"] == "run"
    assert payload["run_id"] == "run-1"
    assert payload["interpreter"] == "bash"
    assert "example.com" in payload["script"]

    # Verify DB state of run changed to 'running' and has runner_id
    run_db = await mem_db.get_run("run-1")
    assert run_db["status"] == "running"
    assert run_db["runner_id"] == "local-runner-1"

    # Runner streams log chunk
    resp = await client.post(
        "/api/runners/runs/run-1/log",
        json={"chunk": "Discovering web tech...\n[FERRET:MANIFEST] {\"name\": \"discovered-host.com\", \"type\": \"host\"}\n"},
        headers={"X-Runner-Key": "fr_local_dev_key_default_33794b"}
    )
    assert resp.status_code == 200

    # Runner completes run with exit_code 0
    resp = await client.post(
        "/api/runners/runs/run-1/complete",
        json={"exit_code": 0, "status": "done"},
        headers={"X-Runner-Key": "fr_local_dev_key_default_33794b"}
    )
    assert resp.status_code == 200

    # Verify run completed successfully
    run_db = await mem_db.get_run("run-1")
    assert run_db["status"] == "done"
    assert run_db["exit_code"] == 0

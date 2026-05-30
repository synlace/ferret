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
    resp = await client.post("/api/runners/heartbeat", json={"runner_id": "ferret-runner-test-1", "url": "http://ferret-runner-test-1:8080"})
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}

    # Get active runners list
    resp = await client.get("/api/runners")
    assert resp.status_code == 200
    runners = resp.json()
    assert len(runners) == 1
    assert runners[0]["id"] == "ferret-runner-test-1"
    assert runners[0]["url"] == "http://ferret-runner-test-1:8080"
    assert runners[0]["status"] == "active"

@pytest.mark.asyncio
async def test_runners_offline_timeout(client, mem_db):
    # Register a runner
    await client.post("/api/runners/heartbeat", json={"runner_id": "ferret-runner-temp", "url": None})

    # Forcibly backdate heartbeat to simulate offline status
    await mem_db._db.execute(
        "UPDATE runners SET last_heartbeat = ? WHERE id = ?",
        ((datetime.utcnow() - timedelta(seconds=60)).isoformat(), "ferret-runner-temp")
    )
    await mem_db._db.commit()

    # List active runners — should show the runner as offline due to timeout
    resp = await client.get("/api/runners")
    assert resp.status_code == 200
    runners = resp.json()
    assert len(runners) == 1
    assert runners[0]["id"] == "ferret-runner-temp"
    assert runners[0]["status"] == "offline"

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


@pytest.mark.asyncio
async def test_den_runner_image_and_fanout_propagation(client, mem_db):
    # 1. Create a Den with custom runner_image
    resp = await client.put(
        "/api/settings/dens/aws-den-test",
        json={
            "id": "aws-den-test",
            "name": "AWS Custom Test Den",
            "den_type": "aws",
            "den_max_runners": 5,
            "den_aws_access_key": "AKIA...",
            "den_aws_secret_key": "WJ...",
            "den_aws_region": "eu-west-1",
            "den_runner_image": "1234567890.dkr.ecr.eu-west-1.amazonaws.com/ferret-runner:custom"
        }
    )
    assert resp.status_code == 200

    # Retrieve Den configuration and verify den_runner_image matches
    resp = await client.get("/api/settings/dens/aws-den-test")
    assert resp.status_code == 200
    data = resp.json()
    assert data["den_runner_image"] == "1234567890.dkr.ecr.eu-west-1.amazonaws.com/ferret-runner:custom"

    # Verify database record has runner_image
    den_db = await mem_db.get_den("aws-den-test")
    assert den_db is not None
    assert den_db["runner_image"] == "1234567890.dkr.ecr.eu-west-1.amazonaws.com/ferret-runner:custom"


@pytest.mark.asyncio
async def test_runner_workspace_archive_upload(client, mem_db, tmp_path):
    import io
    import zipfile
    import deps

    # Patch WORKSPACES_DIR to use our temp path so we don't write to real data/
    deps.WORKSPACES_DIR = tmp_path

    # Pre-seed a project and workspace
    now = datetime.now(timezone.utc)
    await mem_db._db.execute(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('temp', 'temp', ?, ?)",
        (now.isoformat(), now.isoformat())
    )
    await mem_db._db.execute(
        "INSERT INTO workspaces (id, project_id, name, created_at) VALUES ('ws-archive-test', 'temp', 'ws-archive-test', ?)",
        (now.isoformat(),)
    )
    await mem_db._db.commit()

    # Create a running run
    run = Run(
        id="run-archive-test",
        workspace_id="ws-archive-test",
        project_id="temp",
        plan_id="builtin:whatweb",
        target_url="http://example.com",
        status="running",
        created_at=datetime.utcnow()
    )
    await mem_db.create_run(run)

    # Prepare an in-memory ZIP file with a directory and a file
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "a", zipfile.ZIP_DEFLATED, False) as zip_file:
        zip_file.writestr("notes/whatweb_raw.json", '{"http_status": 200}')
        zip_file.writestr("notes/whatweb.md", "# WhatWeb Scan Report")

    zip_buffer.seek(0)

    # Post the ZIP to the server archive upload endpoint
    resp = await client.post(
        "/api/runners/runs/run-archive-test/workspace-archive",
        files={"file": ("workspace.zip", zip_buffer, "application/zip")},
        headers={"X-Runner-Key": "fr_local_dev_key_default_33794b"}
    )
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}

    # Verify that the files were extracted to the correct workspace dir
    ws_real_root = deps.WORKSPACES_DIR / "temp" / "ws-archive-test"
    assert (ws_real_root / "notes" / "whatweb_raw.json").exists()
    assert (ws_real_root / "notes" / "whatweb.md").exists()
    assert (ws_real_root / "notes" / "whatweb_raw.json").read_text() == '{"http_status": 200}'


@pytest.mark.asyncio
async def test_runners_reaping_and_recovery(client, mem_db, tmp_path):
    import io
    import zipfile
    import deps
    from services.script_execution_engine import ScriptExecutionEngine

    deps.WORKSPACES_DIR = tmp_path

    # Pre-seed a project and workspace
    now = datetime.utcnow()
    await mem_db._db.execute(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p-reap', 'p-reap', ?, ?)",
        (now.isoformat(), now.isoformat())
    )
    await mem_db._db.execute(
        "INSERT INTO workspaces (id, project_id, name, created_at) VALUES ('ws-reap', 'p-reap', 'ws-reap', ?)",
        (now.isoformat(),)
    )

    # 1. Create a run that has NOT timed out yet
    run_live = Run(
        id="run-live",
        workspace_id="ws-reap",
        project_id="p-reap",
        plan_id="builtin:whatweb",
        target_url="http://example.com",
        status="running",
        created_at=now - timedelta(seconds=10),
        timeout=120
    )
    await mem_db.create_run(run_live)

    # Create a run that HAS timed out (created 20 minutes ago, timeout 10 minutes)
    run_timed_out = Run(
        id="run-timed-out",
        workspace_id="ws-reap",
        project_id="p-reap",
        plan_id="builtin:whatweb",
        target_url="http://example.com",
        status="running",
        created_at=now - timedelta(minutes=20),
        timeout=600
    )
    await mem_db.create_run(run_timed_out)

    await mem_db._db.commit()

    # 2. Trigger start_scheduler
    engine = ScriptExecutionEngine(db_client=mem_db)
    # Patch self._scheduler_loop to be a no-op so it doesn't spin in background
    async def mock_scheduler_loop():
        pass
    engine._scheduler_loop = mock_scheduler_loop

    await engine.start_scheduler()

    # 3. Assert run-live is PRESERVED in "running" status
    run_live_db = await mem_db.get_run("run-live")
    assert run_live_db["status"] == "running"

    # 4. Assert run-timed-out is REAPED into "error" status
    run_timed_out_db = await mem_db.get_run("run-timed-out")
    assert run_timed_out_db["status"] == "error"

    # 5. Let's test archive upload state recovery for "run-timed-out"
    # Recover state back to "done" upon workspace-archive upload
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "a", zipfile.ZIP_DEFLATED, False) as zip_file:
        zip_file.writestr("notes/whatweb_raw.json", '{"http_status": 200}')
    zip_buffer.seek(0)

    resp = await client.post(
        "/api/runners/runs/run-timed-out/workspace-archive",
        files={"file": ("workspace.zip", zip_buffer, "application/zip")},
        headers={"X-Runner-Key": "fr_local_dev_key_default_33794b"}
    )
    assert resp.status_code == 200

    # Verify run-timed-out status is now recovered to "done"
    run_timed_out_db_after = await mem_db.get_run("run-timed-out")
    assert run_timed_out_db_after["status"] == "done"
    assert run_timed_out_db_after["exit_code"] == 0


@pytest.mark.asyncio
async def test_warm_pool_reaping(client, mem_db):
    from services.script_execution_engine import ScriptExecutionEngine
    import time
    import asyncio

    # 1. Create an AWS Den with warm_runners=2
    await mem_db._db.execute(
        """
        INSERT INTO dens (id, name, type, max_runners, warm_runners, created_at)
        VALUES ('aws-reap-den', 'AWS Reap Den', 'aws', 5, 2, '2026-05-30T00:00:00')
        """
    )

    # Pre-seed a project and workspace
    now_str = datetime.utcnow().isoformat()
    await mem_db._db.execute(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p-reap-warm', 'p-reap-warm', ?, ?)",
        (now_str, now_str)
    )
    await mem_db._db.execute(
        "INSERT INTO workspaces (id, project_id, name, created_at) VALUES ('ws-reap-warm', 'p-reap-warm', 'ws-reap-warm', ?)",
        (now_str,)
    )

    # Register 3 active runners for this den
    hb_r1 = (datetime.utcnow() - timedelta(hours=1)).isoformat()
    hb_r2 = (datetime.utcnow() - timedelta(minutes=30)).isoformat()
    hb_r3 = (datetime.utcnow() - timedelta(minutes=5)).isoformat()

    await mem_db._db.execute(
        "INSERT INTO runners (id, status, last_heartbeat) VALUES ('runner-fargate-aws-reap-den-r1', 'active', ?)",
        (hb_r1,)
    )
    await mem_db._db.execute(
        "INSERT INTO runners (id, status, last_heartbeat) VALUES ('runner-fargate-aws-reap-den-r2', 'active', ?)",
        (hb_r2,)
    )
    await mem_db._db.execute(
        "INSERT INTO runners (id, status, last_heartbeat) VALUES ('runner-fargate-aws-reap-den-r3', 'active', ?)",
        (hb_r3,)
    )

    # Make r2 busy with a running run
    await mem_db._db.execute(
        """
        INSERT INTO runs (id, workspace_id, status, runner_id, den_id, created_at)
        VALUES ('run-busy-r2', 'ws-reap-warm', 'running', 'runner-fargate-aws-reap-den-r2', 'aws-reap-den', '2026-05-30T00:00:00')
        """
    )
    await mem_db._db.commit()

    # 2. Trigger _maintain_warm_pools
    engine = ScriptExecutionEngine(db_client=mem_db)
    engine._startup_time = time.time() - 100.0

    await engine._maintain_warm_pools()

    # Wait briefly for background tasks
    await asyncio.sleep(0.1)

    # 3. Verify
    runners = await mem_db.get_active_runners(timeout_seconds=3600)
    runner_states = {r["id"]: r["status"] for r in runners}

    assert runner_states["runner-fargate-aws-reap-den-r1"] == "offline"
    assert runner_states["runner-fargate-aws-reap-den-r2"] == "active"
    assert runner_states["runner-fargate-aws-reap-den-r3"] == "active"




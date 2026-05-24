"""
FERRET API — pytest unit tests for Hunt Plans endpoints (filesystem-only).

Plans are now stored as .md files:
  Built-in plans:  src/apps/api/plans/*.md          (read-only, shipped with app)
  User plans:      {PLANS_USER_DIR}/*.md             (created/edited/deleted at runtime)

Covers
------
GET /api/plans?project_id={project_id}:
  - Returns a list
  - Built-in plans are included (is_builtin == True)
  - All four built-in plan names are present
  - All built-in plans have tool == "hunt"
  - Built-in plan IDs are prefixed with "builtin:"

POST /api/plans:
  - Creates a plan with valid body
  - Response contains id, name, created_at, is_builtin == False
  - Returns 422 if name is missing
  - Returns 422 if prompt is missing

PUT /api/plans/{plan_id}:
  - Updates name and prompt of a user plan
  - Returns updated values
  - Returns 403 when attempting to update a built-in plan
  - Returns 404 for a non-existent plan_id

DELETE /api/plans/{plan_id}?project_id={project_id}:
  - Deletes a user plan
  - Returns 403 when attempting to delete a built-in plan
  - Returns 404 for a non-existent plan_id

POST /api/plans/{plan_id}/clone:
  - Clones a built-in plan into user plans
  - Cloned plan has is_builtin == False
  - Cloned plan name matches the original

_parse_plan_file / _load_all_plans:
  - Parser handles valid front-matter
  - Parser returns None for files without front-matter
  - All four built-in plan names are loaded
  - All built-in plans reference write_note in their prompts

Run with:
    cd github/ferret/src/apps/api
    pytest test_api_plans.py -v
"""

import pytest
from pathlib import Path
from unittest.mock import patch

import deps as deps_module

# conftest.py provides: client, mem_db fixtures

BUILTIN_PLAN_NAMES = {"Quick Recon", "Full Recon", "API Surface", "Passive Subdomain Enum"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _create_plan(client, tmp_path, project_id: str = "temp", **overrides) -> dict:
    """Create a plan via the API (with PLANS_USER_DIR patched to tmp_path) and return the JSON."""
    payload = {
        "name": "My Test Plan",
        "description": "A test plan",
        "tool": "hunt",
        "prompt": "Run a test against {{target}}.",
        "max_tool_calls": 10,
    }
    payload.update(overrides)
    with patch.object(deps_module, "PLANS_USER_DIR", tmp_path):
        resp = await client.post(f"/api/plans?project_id={project_id}", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _get_builtin_plan_id(client) -> str:
    """Return the ID of the first built-in plan from the list."""
    resp = await client.get("/api/plans?project_id=temp")
    assert resp.status_code == 200, resp.text
    plans = resp.json()
    for plan in plans:
        if plan.get("is_builtin"):
            return plan["id"]
    raise AssertionError("No built-in plan found in list")


# ---------------------------------------------------------------------------
# GET /api/plans
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_plans_returns_list(client):
    """GET /api/plans → 200 with a list."""
    resp = await client.get("/api/plans?project_id=temp")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.asyncio
async def test_list_plans_includes_builtins(client):
    """GET /api/plans → built-in plans are present (is_builtin truthy)."""
    resp = await client.get("/api/plans?project_id=temp")
    assert resp.status_code == 200
    plans = resp.json()
    builtin_plans = [p for p in plans if p.get("is_builtin")]
    assert len(builtin_plans) > 0, "Expected at least one built-in plan"


@pytest.mark.asyncio
async def test_list_plans_all_four_builtin_names_present(client):
    """GET /api/plans → all four built-in plan names are present."""
    resp = await client.get("/api/plans?project_id=temp")
    assert resp.status_code == 200
    plans = resp.json()
    names = {p["name"] for p in plans if p.get("is_builtin")}
    assert BUILTIN_PLAN_NAMES.issubset(names), (
        f"Expected built-in names {BUILTIN_PLAN_NAMES} to be in {names}"
    )


@pytest.mark.asyncio
async def test_list_plans_builtins_have_tool_hunt(client):
    """GET /api/plans → core built-in plans have tool == 'hunt'."""
    resp = await client.get("/api/plans?project_id=temp")
    assert resp.status_code == 200
    plans = resp.json()
    for plan in plans:
        if plan.get("is_builtin") and plan["name"] in {"Quick Recon", "Full Recon", "API Surface"}:
            assert plan["tool"] == "hunt", (
                f"Built-in plan '{plan['name']}' has unexpected tool: {plan['tool']!r}"
            )


@pytest.mark.asyncio
async def test_list_plans_builtin_ids_prefixed(client):
    """GET /api/plans → built-in plan IDs are prefixed with 'builtin:'."""
    resp = await client.get("/api/plans?project_id=temp")
    assert resp.status_code == 200
    plans = resp.json()
    for plan in plans:
        if plan.get("is_builtin"):
            assert plan["id"].startswith("builtin:"), (
                f"Built-in plan '{plan['name']}' has unexpected id: {plan['id']!r}"
            )


# ---------------------------------------------------------------------------
# POST /api/plans
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_create_plan_success(client, tmp_path):
    """POST /api/plans → 201 with id, name, created_at, is_builtin == False."""
    plan = await _create_plan(client, tmp_path)
    assert "id" in plan
    assert plan["name"] == "My Test Plan"
    assert "created_at" in plan
    assert not plan["is_builtin"]


@pytest.mark.asyncio
async def test_create_plan_is_not_builtin(client, tmp_path):
    """POST /api/plans → created plan has is_builtin == False."""
    plan = await _create_plan(client, tmp_path)
    assert not plan["is_builtin"]


@pytest.mark.asyncio
async def test_create_plan_missing_name_returns_422(client, tmp_path):
    """POST /api/plans → 422 when name is missing."""
    with patch.object(deps_module, "PLANS_USER_DIR", tmp_path):
        resp = await client.post("/api/plans?project_id=temp", json={
            "description": "No name here",
            "prompt": "Do something.",
        })
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_plan_missing_prompt_returns_422(client, tmp_path):
    """POST /api/plans → 422 when prompt is missing."""
    with patch.object(deps_module, "PLANS_USER_DIR", tmp_path):
        resp = await client.post("/api/plans?project_id=temp", json={
            "name": "No Prompt Plan",
            "description": "Missing prompt.",
        })
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# PUT /api/plans/{plan_id}
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_update_plan_success(client, tmp_path):
    """PUT /api/plans/{plan_id} → 200 with updated name and prompt."""
    plan = await _create_plan(client, tmp_path, name="Original Name", prompt="Original prompt.")
    plan_id = plan["id"]

    with patch.object(deps_module, "PLANS_USER_DIR", tmp_path):
        resp = await client.put(f"/api/plans/{plan_id}", json={
            "name": "Updated Name",
            "prompt": "Updated prompt.",
        })
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_update_plan_returns_updated_values(client, tmp_path):
    """PUT /api/plans/{plan_id} → response reflects the new values."""
    plan = await _create_plan(client, tmp_path, name="Before Update", prompt="Before.")
    plan_id = plan["id"]

    with patch.object(deps_module, "PLANS_USER_DIR", tmp_path):
        resp = await client.put(f"/api/plans/{plan_id}", json={
            "name": "After Update",
            "prompt": "After.",
        })
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "After Update"
    assert data["prompt"] == "After."


@pytest.mark.asyncio
async def test_update_builtin_plan_returns_403(client):
    """PUT /api/plans/{plan_id} → 403 when plan is built-in."""
    builtin_id = await _get_builtin_plan_id(client)

    resp = await client.put(f"/api/plans/{builtin_id}", json={
        "name": "Hacked Built-in",
    })
    assert resp.status_code == 403
    assert "built-in" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_update_nonexistent_plan_returns_404(client, tmp_path):
    """PUT /api/plans/{plan_id} → 404 for a non-existent plan_id."""
    with patch.object(deps_module, "PLANS_USER_DIR", tmp_path):
        resp = await client.put("/api/plans/nonexistent-plan-id", json={
            "name": "Ghost Plan",
        })
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# DELETE /api/plans/{plan_id}
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_plan_success(client, tmp_path):
    """DELETE /api/plans/{plan_id} → 204 after creating and deleting a plan."""
    plan = await _create_plan(client, tmp_path, project_id="temp")
    plan_id = plan["id"]

    with patch.object(deps_module, "PLANS_USER_DIR", tmp_path):
        resp = await client.delete(f"/api/plans/{plan_id}?project_id=temp")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_delete_plan_no_longer_in_list(client, tmp_path):
    """After deletion, the plan no longer appears in GET /api/plans."""
    plan = await _create_plan(client, tmp_path, project_id="temp", name="To Be Deleted")
    plan_id = plan["id"]

    with patch.object(deps_module, "PLANS_USER_DIR", tmp_path):
        del_resp = await client.delete(f"/api/plans/{plan_id}?project_id=temp")
    assert del_resp.status_code == 204

    with patch.object(deps_module, "PLANS_USER_DIR", tmp_path):
        list_resp = await client.get("/api/plans?project_id=temp")
    assert list_resp.status_code == 200
    ids = [p["id"] for p in list_resp.json()]
    assert plan_id not in ids


@pytest.mark.asyncio
async def test_delete_builtin_plan_returns_403(client):
    """DELETE /api/plans/{plan_id} → 403 when plan is built-in."""
    builtin_id = await _get_builtin_plan_id(client)

    resp = await client.delete(f"/api/plans/{builtin_id}?project_id=temp")
    assert resp.status_code == 403
    assert "built-in" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_delete_nonexistent_plan_returns_404(client, tmp_path):
    """DELETE /api/plans/{plan_id} → 404 for a non-existent plan_id."""
    with patch.object(deps_module, "PLANS_USER_DIR", tmp_path):
        resp = await client.delete("/api/plans/nonexistent-plan-id?project_id=temp")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# POST /api/plans/{plan_id}/clone
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_clone_builtin_plan_success(client, tmp_path):
    """POST /api/plans/{plan_id}/clone → 201 clones a built-in plan."""
    builtin_id = await _get_builtin_plan_id(client)

    with patch.object(deps_module, "PLANS_USER_DIR", tmp_path):
        resp = await client.post(f"/api/plans/{builtin_id}/clone?project_id=temp")
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_clone_plan_is_not_builtin(client, tmp_path):
    """POST /api/plans/{plan_id}/clone → cloned plan has is_builtin == False."""
    builtin_id = await _get_builtin_plan_id(client)

    with patch.object(deps_module, "PLANS_USER_DIR", tmp_path):
        resp = await client.post(f"/api/plans/{builtin_id}/clone?project_id=temp")
    assert resp.status_code == 201
    data = resp.json()
    assert not data["is_builtin"]


@pytest.mark.asyncio
async def test_clone_plan_name_matches_original(client, tmp_path):
    """POST /api/plans/{plan_id}/clone → cloned plan name matches the original."""
    list_resp = await client.get("/api/plans?project_id=temp")
    assert list_resp.status_code == 200
    plans = list_resp.json()
    builtin = next(p for p in plans if p.get("is_builtin"))
    original_name = builtin["name"]
    builtin_id = builtin["id"]

    with patch.object(deps_module, "PLANS_USER_DIR", tmp_path):
        resp = await client.post(f"/api/plans/{builtin_id}/clone?project_id=temp")
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == original_name


@pytest.mark.asyncio
async def test_clone_nonexistent_plan_returns_404(client, tmp_path):
    """POST /api/plans/{plan_id}/clone → 404 for a non-existent plan_id."""
    with patch.object(deps_module, "PLANS_USER_DIR", tmp_path):
        resp = await client.post("/api/plans/nonexistent-plan-id/clone?project_id=temp")
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# _parse_plan_file / _load_all_plans — unit tests for the .md parser
# ---------------------------------------------------------------------------

def test_parse_plan_file_valid(tmp_path):
    """_parse_plan_file returns a dict for a valid .md file."""
    from routers.plans import _parse_plan_file
    md = tmp_path / "test_plan.md"
    md.write_text(
        "---\nname: Test Plan\ndescription: A test.\ntool: hunt\nmax_tool_calls: 10\n---\n\nDo something.\n"
    )
    plan = _parse_plan_file(md)
    assert plan is not None
    assert plan["name"] == "Test Plan"
    assert plan["tool"] == "hunt"
    assert plan["max_tool_calls"] == 10
    assert plan["prompt"] == "Do something."


def test_parse_plan_file_no_front_matter_returns_none(tmp_path):
    """_parse_plan_file returns None for a file without front-matter."""
    from routers.plans import _parse_plan_file
    md = tmp_path / "bad.md"
    md.write_text("Just some text without front-matter.\n")
    assert _parse_plan_file(md) is None


def test_parse_plan_file_missing_name_returns_none(tmp_path):
    """_parse_plan_file returns None when the name key is absent."""
    from routers.plans import _parse_plan_file
    md = tmp_path / "no_name.md"
    md.write_text("---\ndescription: No name here.\n---\n\nPrompt.\n")
    assert _parse_plan_file(md) is None


def test_load_all_plans_returns_four_builtins():
    """_load_all_plans() returns at least four built-in plans."""
    from routers.plans import _load_all_plans
    import deps as d
    # Patch user dir to an empty tmp dir so only builtins are returned
    from pathlib import Path
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        with patch.object(d, "PLANS_USER_DIR", Path(td)):
            plans = _load_all_plans()
    builtins = [p for p in plans if p.get("is_builtin")]
    assert len(builtins) >= 4, f"Expected at least 4 built-ins, got {len(builtins)}"


def test_load_all_plans_builtin_names():
    """_load_all_plans() returns all expected built-in names."""
    from routers.plans import _load_all_plans
    import deps as d
    from pathlib import Path
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        with patch.object(d, "PLANS_USER_DIR", Path(td)):
            plans = _load_all_plans()
    names = {p["name"] for p in plans if p.get("is_builtin")}
    assert BUILTIN_PLAN_NAMES.issubset(names)


def test_builtin_plans_reference_write_note():
    """Core built-in plan prompts reference the write_note tool."""
    from routers.plans import _load_all_plans
    import deps as d
    from pathlib import Path
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        with patch.object(d, "PLANS_USER_DIR", Path(td)):
            plans = _load_all_plans()
    for plan in plans:
        if plan.get("is_builtin") and plan["name"] in {"Quick Recon", "Full Recon", "API Surface"}:
            assert "write_note" in plan["prompt"], (
                f"Built-in plan '{plan['name']}' prompt does not reference write_note"
            )

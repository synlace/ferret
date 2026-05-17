"""
FERRET API — pytest unit tests for Hunt Plans endpoints.

Covers
------
GET /api/plans?project_id={project_id}:
  - Returns a list
  - Built-in plans are included (is_builtin == 1)
  - All four built-in plan names are present
  - All built-in plans have tool == "hunt"

POST /api/plans:
  - Creates a plan with valid body
  - Response contains id, name, created_at, is_builtin == 0
  - Returns 422 if name is missing
  - Returns 422 if prompt is missing

PUT /api/plans/{plan_id}:
  - Updates name and prompt of a user-created plan
  - Returns updated values
  - Returns 403 when attempting to update a built-in plan
  - Returns 404 for a non-existent plan_id

DELETE /api/plans/{plan_id}?project_id={project_id}:
  - Deletes a user-created plan
  - Returns 403 when attempting to delete a built-in plan
  - Returns 404 for a non-existent plan_id

POST /api/plans/{plan_id}/clone?project_id={project_id}:
  - Clones a built-in plan into the project
  - Cloned plan has is_builtin == 0
  - Cloned plan has the correct project_id
  - Cloned plan name matches the original

Run with:
    cd github/ferret/src/apps/api
    pytest test_api_plans.py -v
"""

import pytest

# conftest.py provides: client, mem_db fixtures

BUILTIN_PLAN_NAMES = {"Quick Recon", "Full Recon", "API Surface", "Subdomain Enum"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _create_plan(client, project_id: str = "temp", **overrides) -> dict:
    """Create a plan via the API and return the response JSON."""
    payload = {
        "name": "My Test Plan",
        "description": "A test plan",
        "tool": "hunt",
        "prompt": "Run a test against {{target}}.",
        "max_tool_calls": 10,
    }
    payload.update(overrides)
    resp = await client.post(f"/api/plans?project_id={project_id}", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _get_builtin_plan_id(client, project_id: str = "temp") -> str:
    """Return the ID of the first built-in plan from the list."""
    resp = await client.get(f"/api/plans?project_id={project_id}")
    assert resp.status_code == 200, resp.text
    plans = resp.json()
    for plan in plans:
        if plan.get("is_builtin"):
            return plan["id"]
    raise AssertionError("No built-in plan found in list")


# ---------------------------------------------------------------------------
# GET /api/plans?project_id={project_id}
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
    assert BUILTIN_PLAN_NAMES == names, (
        f"Expected built-in names {BUILTIN_PLAN_NAMES}, got {names}"
    )


@pytest.mark.asyncio
async def test_list_plans_builtins_have_tool_hunt(client):
    """GET /api/plans → all built-in plans have tool == 'hunt'."""
    resp = await client.get("/api/plans?project_id=temp")
    assert resp.status_code == 200
    plans = resp.json()
    for plan in plans:
        if plan.get("is_builtin"):
            assert plan["tool"] == "hunt", (
                f"Built-in plan '{plan['name']}' has tool={plan['tool']!r}, expected 'hunt'"
            )


# ---------------------------------------------------------------------------
# POST /api/plans
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_create_plan_success(client):
    """POST /api/plans → 201 with id, name, created_at, is_builtin == 0."""
    resp = await client.post("/api/plans?project_id=temp", json={
        "name": "Custom Recon",
        "description": "My custom recon plan",
        "tool": "hunt",
        "prompt": "Scan {{target}} thoroughly.",
        "max_tool_calls": 20,
    })
    assert resp.status_code == 201
    data = resp.json()
    assert "id" in data
    assert data["name"] == "Custom Recon"
    assert "created_at" in data
    assert not data["is_builtin"]


@pytest.mark.asyncio
async def test_create_plan_is_not_builtin(client):
    """POST /api/plans → created plan has is_builtin == 0/false."""
    plan = await _create_plan(client)
    assert not plan["is_builtin"]


@pytest.mark.asyncio
async def test_create_plan_missing_name_returns_422(client):
    """POST /api/plans → 422 when name is missing."""
    resp = await client.post("/api/plans?project_id=temp", json={
        "description": "No name here",
        "tool": "hunt",
        "prompt": "Do something.",
    })
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_plan_missing_prompt_returns_422(client):
    """POST /api/plans → 422 when prompt is missing."""
    resp = await client.post("/api/plans?project_id=temp", json={
        "name": "No Prompt Plan",
        "description": "Missing prompt",
        "tool": "hunt",
    })
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# PUT /api/plans/{plan_id}
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_update_plan_success(client):
    """PUT /api/plans/{plan_id} → 200 with updated name and prompt."""
    plan = await _create_plan(client, name="Original Name", prompt="Original prompt.")
    plan_id = plan["id"]

    resp = await client.put(f"/api/plans/{plan_id}", json={
        "name": "Updated Name",
        "prompt": "Updated prompt for {{target}}.",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "Updated Name"
    assert data["prompt"] == "Updated prompt for {{target}}."


@pytest.mark.asyncio
async def test_update_plan_returns_updated_values(client):
    """PUT /api/plans/{plan_id} → response reflects the new values."""
    plan = await _create_plan(client, name="Before Update", prompt="Before.")
    plan_id = plan["id"]

    resp = await client.put(f"/api/plans/{plan_id}", json={
        "name": "After Update",
        "description": "New description",
        "max_tool_calls": 42,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "After Update"
    assert data["description"] == "New description"
    assert data["max_tool_calls"] == 42


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
async def test_update_nonexistent_plan_returns_404(client):
    """PUT /api/plans/{plan_id} → 404 for a non-existent plan_id."""
    resp = await client.put("/api/plans/nonexistent-plan-id", json={
        "name": "Ghost Plan",
    })
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# DELETE /api/plans/{plan_id}?project_id={project_id}
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_plan_success(client):
    """DELETE /api/plans/{plan_id} → 204 after creating and deleting a plan."""
    plan = await _create_plan(client, project_id="temp")
    plan_id = plan["id"]

    resp = await client.delete(f"/api/plans/{plan_id}?project_id=temp")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_delete_plan_no_longer_in_list(client):
    """After deletion, the plan no longer appears in GET /api/plans."""
    plan = await _create_plan(client, project_id="temp", name="To Be Deleted")
    plan_id = plan["id"]

    del_resp = await client.delete(f"/api/plans/{plan_id}?project_id=temp")
    assert del_resp.status_code == 204

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
async def test_delete_nonexistent_plan_returns_404(client):
    """DELETE /api/plans/{plan_id} → 404 for a non-existent plan_id."""
    resp = await client.delete("/api/plans/nonexistent-plan-id?project_id=temp")
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# POST /api/plans/{plan_id}/clone?project_id={project_id}
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_clone_builtin_plan_success(client):
    """POST /api/plans/{plan_id}/clone → 201 clones a built-in plan."""
    builtin_id = await _get_builtin_plan_id(client)

    resp = await client.post(f"/api/plans/{builtin_id}/clone?project_id=temp")
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_clone_plan_is_not_builtin(client):
    """POST /api/plans/{plan_id}/clone → cloned plan has is_builtin == 0."""
    builtin_id = await _get_builtin_plan_id(client)

    resp = await client.post(f"/api/plans/{builtin_id}/clone?project_id=temp")
    assert resp.status_code == 201
    data = resp.json()
    assert not data["is_builtin"]


@pytest.mark.asyncio
async def test_clone_plan_has_correct_project_id(client):
    """POST /api/plans/{plan_id}/clone → cloned plan has the correct project_id."""
    builtin_id = await _get_builtin_plan_id(client)

    resp = await client.post(f"/api/plans/{builtin_id}/clone?project_id=temp")
    assert resp.status_code == 201
    data = resp.json()
    assert data["project_id"] == "temp"


@pytest.mark.asyncio
async def test_clone_plan_name_matches_original(client):
    """POST /api/plans/{plan_id}/clone → cloned plan name matches the original."""
    # Get the list to find a built-in plan with its name
    list_resp = await client.get("/api/plans?project_id=temp")
    assert list_resp.status_code == 200
    plans = list_resp.json()
    builtin = next(p for p in plans if p.get("is_builtin"))
    original_name = builtin["name"]
    builtin_id = builtin["id"]

    resp = await client.post(f"/api/plans/{builtin_id}/clone?project_id=temp")
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == original_name


@pytest.mark.asyncio
async def test_clone_nonexistent_plan_returns_404(client):
    """POST /api/plans/{plan_id}/clone → 404 for a non-existent plan_id."""
    resp = await client.post("/api/plans/nonexistent-plan-id/clone?project_id=temp")
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()

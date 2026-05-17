"""
Hunt Plans endpoints.

Plans are reusable prompt templates for automated hunt sessions.
Built-in plans (is_builtin=1, project_id IS NULL) are read-only and shared
across all projects.  Project-scoped plans (project_id = <id>) are owned by
that project and can be created, updated, deleted, or cloned from a built-in.

Routes:
  GET    /api/plans?project_id=…              list plans (built-ins + project's own)
  POST   /api/plans                           create a new plan
  PUT    /api/plans/{plan_id}                 update a plan (own plans only, not built-ins)
  DELETE /api/plans/{plan_id}?project_id=…   delete a plan (own plans only)
  POST   /api/plans/{plan_id}/clone?project_id=…  clone a built-in into the project
"""

import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import deps

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class PlanCreate(BaseModel):
    name: str
    description: str = ""
    tool: str = "hunt"
    prompt: str
    max_tool_calls: int = 15


class PlanUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    tool: Optional[str] = None
    prompt: Optional[str] = None
    max_tool_calls: Optional[int] = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/api/plans")
async def list_plans(project_id: str = "temp"):
    """Return built-in plans plus plans owned by the given project."""
    try:
        return await deps.db_client.get_plans(project_id)
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/plans", status_code=201)
async def create_plan(body: PlanCreate, project_id: str = "temp"):
    """Create a new project-scoped plan."""
    try:
        plan = {
            "id": str(uuid.uuid4()),
            "project_id": project_id,
            "name": body.name,
            "description": body.description,
            "tool": body.tool,
            "prompt": body.prompt,
            "max_tool_calls": body.max_tool_calls,
            "is_builtin": 0,
            "created_at": datetime.utcnow().isoformat(),
        }
        return await deps.db_client.create_plan(plan)
    except Exception as e:
        raise deps.server_error(e)


@router.put("/api/plans/{plan_id}")
async def update_plan(plan_id: str, body: PlanUpdate):
    """Update a project-scoped plan. Built-in plans cannot be modified."""
    try:
        existing = await deps.db_client.get_plan(plan_id)
        if not existing:
            raise HTTPException(status_code=404, detail="Plan not found")
        if existing.get("is_builtin"):
            raise HTTPException(status_code=403, detail="Built-in plans cannot be modified")
        updates = body.model_dump(exclude_none=True)
        result = await deps.db_client.update_plan(plan_id, updates)
        if result is None:
            raise HTTPException(status_code=404, detail="Plan not found")
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/plans/{plan_id}", status_code=204)
async def delete_plan(plan_id: str, project_id: str = "temp"):
    """Delete a project-scoped plan. Built-in plans cannot be deleted."""
    try:
        existing = await deps.db_client.get_plan(plan_id)
        if not existing:
            raise HTTPException(status_code=404, detail="Plan not found")
        if existing.get("is_builtin"):
            raise HTTPException(status_code=403, detail="Built-in plans cannot be deleted")
        ok = await deps.db_client.delete_plan(plan_id, project_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Plan not found or does not belong to this project")
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/plans/{plan_id}/clone", status_code=201)
async def clone_plan(plan_id: str, project_id: str = "temp"):
    """Clone a built-in plan into the given project."""
    try:
        result = await deps.db_client.clone_plan(plan_id, project_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Plan not found")
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)

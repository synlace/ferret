"""
Application settings endpoints.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import deps

router = APIRouter()


class ActiveProjectBody(BaseModel):
    project_id: str


@router.get("/api/settings/active-project")
async def get_active_project():
    """Return the currently active project ID."""
    try:
        project_id = await deps.db_client.get_setting("active_project_id") or "temp"
        return {"project_id": project_id}
    except Exception as e:
        raise deps.server_error(e)


@router.put("/api/settings/active-project")
async def set_active_project(body: ActiveProjectBody):
    """Set the active project. Validates that the project exists."""
    try:
        project = await deps.db_client.get_project(body.project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        await deps.db_client.set_setting("active_project_id", body.project_id)
        return {"project_id": body.project_id}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)

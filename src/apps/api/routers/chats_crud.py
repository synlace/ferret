"""
Chat session CRUD endpoints.
"""

import asyncio
import json
import logging
import time as _time
import uuid
from datetime import datetime
from fastapi import APIRouter, HTTPException

import deps
from models import ChatSession, ChatSessionCreate, ChatSessionUpdate
from chats_ai import clean_messages_for_display
from plans import _find_plan

_log = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/hunts")
async def get_chat_sessions(project_id: str = "temp"):
    """List all chat sessions."""
    try:
        return await deps.db_client.get_chat_sessions(project_id=project_id)
    except Exception as e:
        raise deps.server_error(e)


async def _run_plan_in_background(
    session_id: str,
    project_id: str,
    prompt: str,
    max_tool_calls: int,
) -> None:
    """Run the agentic loop non-streaming in the background for a hunt session.

    The prompt is injected as the first user message.  We build the OR message
    list directly (system prompt + user prompt) rather than loading history,
    because the session is brand-new and the history is empty at this point.
    All messages are persisted to the DB as they are produced so the UI can
    poll for progress.
    """
    try:
        from chats_engine import AgenticOrchestrator

        # Simply consume the generator to execute the loop.
        # Since is_background=True, database updates and final Done/Error statuses are handled inside.
        async for _ in AgenticOrchestrator.run_loop(
            session_id=session_id,
            project_id=project_id,
            message=prompt,
            max_tool_calls=max_tool_calls,
            is_background=True,
        ):
            pass

    except Exception as exc:
        _log.error("[hunt] unhandled error for session=%s: %s", session_id, exc, exc_info=True)
        try:
            await deps.db_client.update_hunt_status(session_id, "error")
        except Exception:
            pass


@router.post("/api/hunts", status_code=201)
async def create_chat_session(body: ChatSessionCreate, project_id: str = "temp"):
    """Create a new chat session (hunt).

    Workspace resolution:
    - If ``workspace_id`` is supplied, the existing workspace is reused (no mkdir).
    - Otherwise a new workspace is created (using ``workspace_name`` or the
      session name as the workspace name).

    If ``plan_id`` is provided, the plan's prompt is looked up, ``{{target}}``
    is substituted with ``target_url``, and the agentic loop is fired as a
    background task with ``hunt_status`` set to ``'running'``.
    """
    try:
        from workspaces import create_workspace as _create_workspace

        session_id = str(uuid.uuid4())

        # Resolve or create workspace
        if body.workspace_id:
            ws = await deps.db_client.get_workspace(body.workspace_id)
            if not ws:
                raise deps.server_error(ValueError(f"Workspace '{body.workspace_id}' not found"))
            workspace_id = body.workspace_id
            workspace_dir = f"{project_id}/{workspace_id}"
        else:
            ws_name = body.workspace_name or body.name or "workspace"
            ws_obj = await _create_workspace(name=ws_name, project_id=project_id)
            workspace_id = ws_obj.id
            workspace_dir = f"{project_id}/{workspace_id}"

        # Determine initial hunt_status
        hunt_status = "idle"
        plan = None
        if body.plan_id:
            plan = _find_plan(body.plan_id)
            if plan:
                hunt_status = "running"

        session = ChatSession(
            id=session_id,
            name=body.name,
            scope=body.scope,
            scope_data=body.scope_data,
            project_id=project_id,
            workspace_dir=workspace_dir,
            target_url=body.target_url,
            plan_id=body.plan_id,
            hunt_status=hunt_status,
            created_at=datetime.utcnow(),
        )
        # Attach workspace_id for the new column (set via direct attribute)
        session.__dict__["workspace_id"] = workspace_id
        await deps.db_client.create_chat_session(session)

        # Fire the agentic loop in the background if a valid plan was found
        if plan and body.plan_id:
            prompt = plan.get("prompt", "")
            if body.target_url:
                prompt = prompt.replace("{{target}}", body.target_url)
            max_tool_calls = plan.get("max_tool_calls", 15)
            asyncio.create_task(
                _run_plan_in_background(
                    session_id=session_id,
                    project_id=project_id,
                    prompt=prompt,
                    max_tool_calls=max_tool_calls,
                )
            )

        return session
    except Exception as e:
        raise deps.server_error(e)


@router.patch("/api/hunts/{session_id}")
async def update_chat_session(session_id: str, body: ChatSessionUpdate):
    """Update a chat session's name, scope, and/or scope_data."""
    try:
        # Use exclude_unset=True so that explicitly-passed null values (e.g.
        # enabled_tools=null to re-enable all tools) are included in the update.
        updates = body.model_dump(exclude_unset=True)
        ok = await deps.db_client.update_chat_session(session_id, updates)
        if not ok:
            raise HTTPException(status_code=404, detail="Session not found")
        session = await deps.db_client.get_chat_session(session_id)
        return session
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/hunts/{session_id}", status_code=204)
async def delete_chat_session(session_id: str):
    """Delete a chat session and its messages."""
    try:
        ok = await deps.db_client.delete_chat_session(session_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Session not found")
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/hunts/{session_id}/messages")
async def get_session_messages(session_id: str):
    """Get messages for a chat session."""
    try:
        msgs = await deps.db_client.get_chat_history(session_id)
        return {"messages": clean_messages_for_display(msgs)}
    except Exception as e:
        raise deps.server_error(e)

"""
Chats router — CRUD and streaming endpoints for hunt/chat sessions.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time as _time
import uuid
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

import deps
from models import ChatSession, ChatSessionCreate, ChatSessionUpdate, ChatSendRequest
from routers.chats_ai import clean_messages_for_display, _NO_KEY_NOTICE
from routers.chats_ai_litellm import _resolve_project_and_key, stream_ai_completion
from routers.plans import _find_plan

_log = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Background Task Execution
# ---------------------------------------------------------------------------

async def _run_plan_in_background(
    session_id: str,
    project_id: str,
    prompt: str,
    max_tool_calls: int,
) -> None:
    """Run the agentic loop non-streaming in the background for a hunt session."""
    try:
        from chats_engine import AgenticOrchestrator

        # Simply consume the generator to execute the loop.
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


# ---------------------------------------------------------------------------
# CRUD Routes
# ---------------------------------------------------------------------------

@router.get("/api/hunts")
async def get_chat_sessions(project_id: str = "temp"):
    """List all chat sessions."""
    try:
        return await deps.db_client.get_chat_sessions(project_id=project_id)
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/hunts", status_code=201)
async def create_chat_session(body: ChatSessionCreate, project_id: str = "temp"):
    """Create a new chat session (hunt)."""
    try:
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
            ws_obj = await deps.workspace_service.create_workspace(name=ws_name, project_id=project_id)
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


# ---------------------------------------------------------------------------
# Streaming Route
# ---------------------------------------------------------------------------

@router.post("/api/hunts/{session_id}/messages/stream")
async def stream_session_message(
    session_id: str,
    body: ChatSendRequest,
    project_id: str = "temp",
):
    """Stream a chat response as Server-Sent Events using LiteLLM."""
    try:
        project_id, _api_key, _ai_cfg, _project = await _resolve_project_and_key(
            session_id, project_id
        )
    except Exception as e:
        # Handle no-key 503 gracefully — persist notice and stream error event
        if isinstance(e, HTTPException) and e.status_code == 503 and "provisioned key" in str(e.detail):
            _detail = str(e.detail)
            _ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
            await deps.db_client.append_chat_message(
                session_id, {"role": "user", "content": body.message, "timestamp": _ts}
            )
            await deps.db_client.append_chat_message(
                session_id, {"role": "notice", "content": _NO_KEY_NOTICE, "timestamp": _ts}
            )

            async def _no_key_stream():
                yield f"data: {json.dumps({'type': 'error', 'detail': _detail})}\n\n"

            return StreamingResponse(_no_key_stream(), media_type="text/event-stream")
        raise

    _project_model = (
        (_project.get("default_model") if _project else None)
        or _ai_cfg.get("model")
        or deps.OPENROUTER_MODEL
    )
    model = body.model or _project_model
    _log.info(
        "[chat/stream] session=%s model=%s provider=%s",
        session_id, model, _ai_cfg.get("provider"),
    )

    async def _generate():
        try:
            from chats_engine import AgenticOrchestrator

            async for event in AgenticOrchestrator.run_loop(
                session_id=session_id,
                project_id=project_id,
                message=body.message,
                max_tool_calls=body.max_tool_calls or 10,
                model=model,
                is_background=False,
            ):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            _log.error("[chat/stream] error in generator: %s", e)
            yield f"data: {json.dumps({'type': 'error', 'detail': str(e)})}\n\n"

    return StreamingResponse(_generate(), media_type="text/event-stream")

"""
Chat session CRUD endpoints.
"""

import uuid
from datetime import datetime
from fastapi import APIRouter, HTTPException

import deps
from models import ChatSession, ChatSessionCreate, ChatSessionUpdate

router = APIRouter()


@router.get("/api/chats")
async def get_chat_sessions(project_id: str = "temp"):
    """List all chat sessions."""
    try:
        return await deps.db_client.get_chat_sessions(project_id=project_id)
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/chats", status_code=201)
async def create_chat_session(body: ChatSessionCreate, project_id: str = "temp"):
    """Create a new chat session / workspace."""
    try:
        session_id = str(uuid.uuid4())
        workspace_dir = f"{project_id}/{session_id}"

        # Create workspace subdirectories on the host filesystem
        workspace_root = deps.WORKSPACES_DIR / workspace_dir
        for subdir in ("scripts", "tests", "notes"):
            (workspace_root / subdir).mkdir(parents=True, exist_ok=True)

        session = ChatSession(
            id=session_id,
            name=body.name,
            scope=body.scope,
            scope_data=body.scope_data,
            project_id=project_id,
            workspace_dir=workspace_dir,
            created_at=datetime.utcnow(),
        )
        await deps.db_client.create_chat_session(session)
        return session
    except Exception as e:
        raise deps.server_error(e)


@router.patch("/api/chats/{session_id}")
async def update_chat_session(session_id: str, body: ChatSessionUpdate):
    """Update a chat session's name, scope, and/or scope_data."""
    try:
        updates = body.model_dump(exclude_none=True)
        ok = await deps.db_client.update_chat_session(session_id, updates)
        if not ok:
            raise HTTPException(status_code=404, detail="Session not found")
        session = await deps.db_client.get_chat_session(session_id)
        return session
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/chats/{session_id}", status_code=204)
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


@router.get("/api/chats/{session_id}/messages")
async def get_session_messages(session_id: str):
    """Get messages for a chat session."""
    try:
        msgs = await deps.db_client.get_chat_history(session_id)
        return {"messages": msgs}
    except Exception as e:
        raise deps.server_error(e)

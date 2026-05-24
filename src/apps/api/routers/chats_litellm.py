"""
Chat — LiteLLM-backed streaming router.

Exposes:
  POST /api/hunts/{session_id}/messages/stream

SSE event types:
  {"type": "delta",            "content": "..."}
  {"type": "replace",          "content": "...", "thinking"?: "..."}
  {"type": "tool_start",       "name": "...", "args": "..."}
  {"type": "tool_output_chunk","name": "...", "chunk": "..."}
  {"type": "tool_result",      "name": "...", "content": "..."}
  {"type": "done",             "messages": [...]}
  {"type": "error",            "detail": "..."}
"""

from __future__ import annotations

import json
import logging
import time as _time
from datetime import datetime, timezone
from typing import List, Dict, Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

import deps
from models import ChatSendRequest

from routers.chats_ai import _NO_KEY_NOTICE
from routers.chats_ai_litellm import _resolve_project_and_key, stream_ai_completion
from routers.chats_execute import execute_tool_call

_log = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Streaming endpoint
# ---------------------------------------------------------------------------

@router.post("/api/hunts/{session_id}/messages/stream")
async def stream_session_message_v2(
    session_id: str,
    body: ChatSendRequest,
    project_id: str = "temp",
):
    """Stream a chat response as Server-Sent Events using LiteLLM.

    Streams a chat response as Server-Sent Events using LiteLLM.
    """
    try:
        project_id, _api_key, _ai_cfg, _project = await _resolve_project_and_key(
            session_id, project_id
        )
    except Exception as e:
        # Handle no-key 503 gracefully — persist notice and stream error event
        from fastapi import HTTPException as _HTTPException
        if isinstance(e, _HTTPException) and e.status_code == 503 and "provisioned key" in str(e.detail):
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
        "[chat/v2/stream] session=%s model=%s provider=%s",
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
            _log.error("[chat/v2/stream] error in generator: %s", e)
            yield f"data: {json.dumps({'type': 'error', 'detail': str(e)})}\n\n"

    return StreamingResponse(_generate(), media_type="text/event-stream")

    return StreamingResponse(_generate(), media_type="text/event-stream")

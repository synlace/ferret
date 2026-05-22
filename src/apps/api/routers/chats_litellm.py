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

from chats_tools import resolve_tools
from chats_runners import stream_run_script, stream_run_ffuf, stream_run_katana, stream_run_nuclei
from chats_execute import execute_tool_call
from chats_ai import (
    _NO_KEY_NOTICE,
    _extract_thinking,
    extract_nonstandard_tool_calls,
    _build_or_messages,
    clean_messages_for_display,
)
from chats_ai_litellm import (
    _resolve_project_and_key,
    stream_ai_completion,
)

_log = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Shared helper: attach __META__ timing to a tool result string
# (identical to the one in chats.py — kept local to avoid circular imports)
# ---------------------------------------------------------------------------

def _attach_meta(tool_result: str, runtime_ms: int, exit_code: int | None = None) -> str:
    _ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    _meta_prefix = "\n__META__:"
    _meta_idx = tool_result.rfind(_meta_prefix)
    if _meta_idx != -1:
        try:
            existing = json.loads(tool_result[_meta_idx + len(_meta_prefix):])
        except Exception:
            existing = {}
        existing["runtime_ms"] = runtime_ms
        existing["timestamp"] = _ts
        if exit_code is not None:
            existing["exit_code"] = exit_code
        return tool_result[:_meta_idx] + _meta_prefix + json.dumps(existing)
    meta: dict = {"runtime_ms": runtime_ms, "timestamp": _ts}
    if exit_code is not None:
        meta["exit_code"] = exit_code
    return tool_result + _meta_prefix + json.dumps(meta)


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
        # Load enabled tools from DB — never from request body
        _session_record = await deps.db_client.get_chat_session(session_id)
        _enabled_tools_names = (
            _session_record.get("enabled_tools") if _session_record else None
        )
        _tools_for_prompt = resolve_tools(_enabled_tools_names)
        _allowed_tool_names = {t["function"]["name"] for t in _tools_for_prompt}

        history = await deps.db_client.get_chat_history(session_id)
        or_messages = _build_or_messages(history, body.message, tools=_tools_for_prompt)

        # Persist user message immediately so it survives a client abort
        _ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
        await deps.db_client.append_chat_message(
            session_id, {"role": "user", "content": body.message, "timestamp": _ts}
        )

        new_messages: List[Dict[str, Any]] = []
        max_iterations = max(1, min(50, body.max_tool_calls or 10))
        _hit_limit = False
        _total_usage: Dict[str, int] = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

        for _iteration in range(max_iterations):
            accumulated_content = ""
            accumulated_tool_calls: List[Dict[str, Any]] = []

            # ----------------------------------------------------------------
            # Stream from LiteLLM
            # ----------------------------------------------------------------
            try:
                async for text_delta, tool_calls, _usage in stream_ai_completion(
                    _ai_cfg,
                    _api_key or "",
                    model,
                    or_messages + new_messages,
                    tools=_tools_for_prompt or None,
                ):
                    if text_delta:
                        accumulated_content += text_delta
                    if tool_calls:
                        accumulated_tool_calls = tool_calls
                    if _usage:
                        _total_usage["prompt_tokens"] += _usage.get("prompt_tokens", 0)
                        _total_usage["completion_tokens"] += _usage.get("completion_tokens", 0)
                        _total_usage["total_tokens"] += _usage.get("total_tokens", 0)
            except Exception as e:
                _log.error("[chat/v2/stream] LiteLLM error: %s", e)
                yield f"data: {json.dumps({'type': 'error', 'detail': str(e)})}\n\n"
                return

            # ----------------------------------------------------------------
            # Post-process: extract thinking blocks, strip tool_code tags
            # ----------------------------------------------------------------
            if accumulated_content:
                _clean_content, _thinking = _extract_thinking(accumulated_content)
                # Fallback: parse non-standard <|tool_call> tags when the provider
                # returned no structured tool_calls (common with local models).
                if not accumulated_tool_calls:
                    _ns_tool_calls = extract_nonstandard_tool_calls(accumulated_content)
                    accumulated_tool_calls = _ns_tool_calls
                accumulated_content = _clean_content
                _replace_evt: Dict[str, Any] = {"type": "replace", "content": _clean_content}
                if _thinking:
                    _replace_evt["thinking"] = _thinking
                yield f"data: {json.dumps(_replace_evt)}\n\n"
            else:
                _thinking = None

            # ----------------------------------------------------------------
            # Build assistant message
            # ----------------------------------------------------------------
            assistant_msg: Dict[str, Any] = {
                "role": "assistant",
                "content": accumulated_content or None,
            }
            if accumulated_tool_calls:
                assistant_msg["tool_calls"] = accumulated_tool_calls
            if _thinking:
                assistant_msg["thinking"] = _thinking

            # Fallback: empty response with no tool calls
            if not accumulated_content and not accumulated_tool_calls:
                if not _tools_for_prompt:
                    _notice = (
                        "I currently have no tools available in this session. "
                        "Enable one or more tools in the AI Tools panel to proceed."
                    )
                else:
                    _notice = (
                        "The model returned an empty response. "
                        "Try rephrasing your message or switching to a different model."
                    )
                assistant_msg["content"] = _notice
                yield f"data: {json.dumps({'type': 'replace', 'content': _notice})}\n\n"

            new_messages.append(assistant_msg)

            # No tool calls → done
            if not accumulated_tool_calls:
                break

            # ----------------------------------------------------------------
            # Tool calls present — check iteration limit before executing
            # ----------------------------------------------------------------
            if _iteration == max_iterations - 1:
                # Last allowed iteration and still has tool calls — limit hit
                _hit_limit = True
                break

            # Persist assistant message (with tool_calls) before executing tools
            await deps.db_client.append_chat_message(session_id, assistant_msg)

            # ----------------------------------------------------------------
            # Execute tool calls
            # ----------------------------------------------------------------
            for tc in accumulated_tool_calls:
                fn_name = tc["function"]["name"]
                try:
                    fn_args_raw = json.loads(tc["function"].get("arguments", "{}"))
                except json.JSONDecodeError:
                    fn_args_raw = {}

                yield f"data: {json.dumps({'type': 'tool_start', 'name': fn_name, 'args': tc['function'].get('arguments', '{}')})}\n\n"

                if fn_name not in _allowed_tool_names:
                    tool_result = f"[FERRET] Tool '{fn_name}' is disabled for this session."
                    tool_result = _attach_meta(tool_result, 0, exit_code=1)

                elif fn_name == "run_script":
                    _streamer = stream_run_script(
                        fn_args_raw, project_id=project_id, session_id=session_id
                    )
                    tool_result = ""
                    async for _chunk, _is_final, _final_result in _streamer:
                        if _is_final:
                            tool_result = _final_result or ""
                        elif _chunk:
                            yield f"data: {json.dumps({'type': 'tool_output_chunk', 'name': fn_name, 'chunk': _chunk})}\n\n"

                elif fn_name == "run_katana":
                    _streamer = stream_run_katana(fn_args_raw)
                    tool_result = ""
                    async for _chunk, _is_final, _final_result in _streamer:
                        if _is_final:
                            tool_result = _final_result or ""
                        elif _chunk:
                            yield f"data: {json.dumps({'type': 'tool_output_chunk', 'name': fn_name, 'chunk': _chunk})}\n\n"

                elif fn_name == "run_ffuf":
                    _streamer = stream_run_ffuf(fn_args_raw)
                    tool_result = ""
                    async for _chunk, _is_final, _final_result in _streamer:
                        if _is_final:
                            tool_result = _final_result or ""
                        elif _chunk:
                            yield f"data: {json.dumps({'type': 'tool_output_chunk', 'name': fn_name, 'chunk': _chunk})}\n\n"

                elif fn_name == "run_nuclei":
                    _streamer = stream_run_nuclei(fn_args_raw)
                    tool_result = ""
                    async for _chunk, _is_final, _final_result in _streamer:
                        if _is_final:
                            tool_result = _final_result or ""
                        elif _chunk:
                            yield f"data: {json.dumps({'type': 'tool_output_chunk', 'name': fn_name, 'chunk': _chunk})}\n\n"

                else:
                    _t0 = _time.monotonic()
                    _recent_outputs = [
                        m.get("content", "") for m in new_messages if m.get("role") == "tool"
                    ]
                    tool_result = await execute_tool_call(
                        tc,
                        project_id=project_id,
                        session_id=session_id,
                        recent_tool_outputs=_recent_outputs,
                    )
                    _runtime_ms = round((_time.monotonic() - _t0) * 1000)
                    tool_result = _attach_meta(tool_result, _runtime_ms)

                tool_msg = {
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "name": fn_name,
                    "content": tool_result,
                }
                yield f"data: {json.dumps({'type': 'tool_result', 'name': fn_name, 'content': tool_result})}\n\n"
                new_messages.append(tool_msg)
                await deps.db_client.append_chat_message(session_id, tool_msg)

        # Persist the final assistant message (no tool calls)
        if (
            new_messages
            and new_messages[-1].get("role") == "assistant"
            and not new_messages[-1].get("tool_calls")
        ):
            await deps.db_client.append_chat_message(session_id, new_messages[-1])

        if _hit_limit:
            _limit_notice = (
                f"⚠️ **Tool call limit reached** ({max_iterations} calls). "
                "The agent stopped here. Increase the limit or send a follow-up message to continue."
            )
            _notice_msg: Dict[str, Any] = {"role": "notice", "content": _limit_notice}
            await deps.db_client.append_chat_message(session_id, _notice_msg)
            yield f"data: {json.dumps({'type': 'notice', 'content': _limit_notice})}\n\n"

        updated = await deps.db_client.get_chat_history(session_id)
        _done_evt: Dict[str, Any] = {"type": "done", "messages": clean_messages_for_display(updated)}
        if _total_usage["total_tokens"] > 0:
            _done_evt["usage"] = _total_usage
        yield f"data: {json.dumps(_done_evt)}\n\n"

    return StreamingResponse(_generate(), media_type="text/event-stream")

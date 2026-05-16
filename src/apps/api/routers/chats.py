"""
Chat session endpoints — streaming and non-streaming message handlers.

This module is intentionally thin: it wires together the sub-modules and
exposes the two SSE/non-streaming POST routes.  All heavy logic lives in:

  chats_crud.py     — session CRUD routes
  chats_tools.py    — tool definitions (SESSION_CHAT_TOOLS)
  chats_ai.py       — AI provider helpers and system prompt builder
  chats_runners.py  — streaming subprocess helpers (run_script / ffuf / katana)
  chats_execute.py  — tool call dispatcher (execute_tool_call)
"""

import json
import logging
import time as _time
from datetime import datetime, timezone
from typing import List, Dict, Any

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

import deps
from models import ChatSendRequest

from chats_crud import router as _crud_router
from chats_tools import SESSION_CHAT_TOOLS
from chats_ai import (
    _build_ai_request,
    _parse_ai_response,
    _resolve_project_and_key,
    _build_or_messages,
    _NO_KEY_NOTICE,
)
from chats_runners import stream_run_script, stream_run_ffuf, stream_run_katana
from chats_execute import execute_tool_call

# ---------------------------------------------------------------------------
# Backwards-compatible re-exports (used by test_api_chat_tools.py and
# test_api_setup.py which import these names directly from routers.chats).
# ---------------------------------------------------------------------------
_execute_tool_call = execute_tool_call

_log = logging.getLogger(__name__)

router = APIRouter()

# Mount CRUD routes onto the same router
router.include_router(_crud_router)


# ---------------------------------------------------------------------------
# Shared helper: attach __META__ timing to a tool result string
# ---------------------------------------------------------------------------

def _attach_meta(tool_result: str, runtime_ms: int) -> str:
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
        return tool_result[:_meta_idx] + _meta_prefix + json.dumps(existing)
    return tool_result + _meta_prefix + json.dumps({"runtime_ms": runtime_ms, "timestamp": _ts})


# ---------------------------------------------------------------------------
# Non-streaming send (kept for backwards compat / tests)
# ---------------------------------------------------------------------------

@router.post("/api/chats/{session_id}/messages")
async def send_session_message(session_id: str, body: ChatSendRequest, project_id: str = "temp"):
    """Send a message in a chat session.
    Model resolution: body.model → project.default_model → deps.OPENROUTER_MODEL.
    The project_id is derived from the session record; the query param is a fallback only.
    """
    try:
        try:
            project_id, _api_key, _ai_cfg, _project = await _resolve_project_and_key(session_id, project_id)
        except HTTPException as e:
            if e.status_code == 503 and "provisioned key" in str(e.detail):
                _ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
                await deps.db_client.append_chat_message(
                    session_id, {"role": "user", "content": body.message, "timestamp": _ts}
                )
                await deps.db_client.append_chat_message(
                    session_id, {"role": "notice", "content": _NO_KEY_NOTICE, "timestamp": _ts}
                )
                updated = await deps.db_client.get_chat_history(session_id)
                return {"messages": updated}
            raise

        _project_model = (_project.get("default_model") if _project else None) or _ai_cfg.get("model") or deps.OPENROUTER_MODEL
        model = body.model or _project_model
        _log.info("[chat] resolved model=%s provider=%s", model, _ai_cfg.get("provider"))

        history = await deps.db_client.get_chat_history(session_id)
        or_messages = _build_or_messages(history, body.message)

        new_messages: List[Dict[str, Any]] = []
        max_iterations = 5

        # Inject the resolved key into the config dict for _build_ai_request
        _ai_cfg_with_key = {**_ai_cfg, "_resolved_key": _api_key}

        for _ in range(max_iterations):
            _url, _headers, _body = _build_ai_request(
                _ai_cfg_with_key, model, or_messages + new_messages, SESSION_CHAT_TOOLS
            )
            try:
                async with httpx.AsyncClient(timeout=90.0) as client:
                    resp = await client.post(_url, headers=_headers, json=_body)
                    resp.raise_for_status()
                    data = resp.json()
            except httpx.HTTPStatusError as e:
                _log.error("[chat] AI provider error status=%s body=%s", e.response.status_code, e.response.text[:500])
                raise HTTPException(502, f"AI provider {e.response.status_code}: {e.response.text[:200]}")
            except Exception as e:
                raise HTTPException(502, f"AI provider request failed: {e}")

            assistant_msg = _parse_ai_response(_ai_cfg_with_key, data)
            new_messages.append(assistant_msg)

            tool_calls = assistant_msg.get("tool_calls") or []
            if not tool_calls:
                break

            # Collect tool outputs already accumulated in this iteration so that
            # create_finding can validate evidence against them.
            _recent_outputs = [
                m.get("content", "") for m in new_messages if m.get("role") == "tool"
            ]
            for tc in tool_calls:
                _t0 = _time.monotonic()
                tool_result = await execute_tool_call(
                    tc,
                    project_id=project_id,
                    session_id=session_id,
                    recent_tool_outputs=_recent_outputs,
                )
                _runtime_ms = round((_time.monotonic() - _t0) * 1000)
                tool_result = _attach_meta(tool_result, _runtime_ms)
                new_messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "name": tc["function"]["name"],
                    "content": tool_result,
                })

        await deps.db_client.append_chat_message(session_id, {"role": "user", "content": body.message})
        for msg in new_messages:
            await deps.db_client.append_chat_message(session_id, msg)

        updated = await deps.db_client.get_chat_history(session_id)
        return {"messages": updated}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


# ---------------------------------------------------------------------------
# Streaming send — SSE endpoint
# ---------------------------------------------------------------------------

@router.post("/api/chats/{session_id}/messages/stream")
async def stream_session_message(session_id: str, body: ChatSendRequest, project_id: str = "temp"):
    """Stream a chat response as Server-Sent Events.

    Each SSE event is one of:
      data: {"type": "delta", "content": "..."}   — incremental text token
      data: {"type": "tool_start", "name": "..."}  — tool call beginning
      data: {"type": "tool_result", "name": "...", "content": "..."} — tool output
      data: {"type": "done", "messages": [...]}    — final full message list
      data: {"type": "error", "detail": "..."}     — error
    """
    try:
        project_id, _api_key, _ai_cfg, _project = await _resolve_project_and_key(session_id, project_id)
    except HTTPException as e:
        if e.status_code == 503 and "provisioned key" in str(e.detail):
            # Persist user message + notice so they survive a hard page refresh,
            # then stream the error event so the frontend renders it immediately.
            # Capture detail before the except block exits — Python 3.11+ clears
            # the exception variable 'e' after the except block, so the inner
            # async generator cannot reference it by closure.
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

    _project_model = (_project.get("default_model") if _project else None) or _ai_cfg.get("model") or deps.OPENROUTER_MODEL
    model = body.model or _project_model
    _log.info("[chat/stream] session=%s model=%s provider=%s", session_id, model, _ai_cfg.get("provider"))

    # Inject the resolved key into the config dict for _build_ai_request
    _ai_cfg_with_key = {**_ai_cfg, "_resolved_key": _api_key}
    _is_anthropic = _ai_cfg.get("format") == "anthropic"

    async def _generate():
        history = await deps.db_client.get_chat_history(session_id)
        or_messages = _build_or_messages(history, body.message)

        # Persist the user message immediately so it survives a client abort.
        _ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
        await deps.db_client.append_chat_message(
            session_id, {"role": "user", "content": body.message, "timestamp": _ts}
        )

        new_messages: List[Dict[str, Any]] = []
        max_iterations = max(1, min(50, body.max_tool_calls or 10))

        for iteration in range(max_iterations):
            # Stream the completion (OpenAI-compat SSE) or fall back to non-streaming (Anthropic)
            accumulated_content = ""
            accumulated_tool_calls: Dict[int, Dict] = {}

            _url, _headers, _body = _build_ai_request(
                _ai_cfg_with_key, model, or_messages + new_messages, SESSION_CHAT_TOOLS
            )

            if _is_anthropic:
                # Anthropic uses a different streaming format; use non-streaming and emit
                # the full response as a single delta so the frontend still works.
                try:
                    async with httpx.AsyncClient(timeout=90.0) as client:
                        resp = await client.post(_url, headers=_headers, json=_body)
                        resp.raise_for_status()
                        data = resp.json()
                except httpx.HTTPStatusError as e:
                    yield f"data: {json.dumps({'type': 'error', 'detail': f'Anthropic {e.response.status_code}: {e.response.text[:200]}'})}\n\n"
                    return
                except Exception as e:
                    yield f"data: {json.dumps({'type': 'error', 'detail': str(e)})}\n\n"
                    return

                assistant_msg = _parse_ai_response(_ai_cfg_with_key, data)
                text = assistant_msg.get("content") or ""
                if text:
                    accumulated_content = text
                    yield f"data: {json.dumps({'type': 'delta', 'content': text})}\n\n"
                # Collect tool calls from parsed message
                for tc in (assistant_msg.get("tool_calls") or []):
                    idx = len(accumulated_tool_calls)
                    accumulated_tool_calls[idx] = tc

            else:
                # OpenAI-compatible SSE streaming
                _body["stream"] = True
                try:
                    async with httpx.AsyncClient(timeout=90.0) as client:
                        async with client.stream("POST", _url, headers=_headers, json=_body) as resp:
                            resp.raise_for_status()
                            async for line in resp.aiter_lines():
                                if not line.startswith("data: "):
                                    continue
                                raw = line[6:]
                                if raw.strip() == "[DONE]":
                                    break
                                try:
                                    chunk = json.loads(raw)
                                except json.JSONDecodeError:
                                    continue

                                delta = chunk.get("choices", [{}])[0].get("delta", {})

                                # Text delta
                                text = delta.get("content") or ""
                                if text:
                                    accumulated_content += text
                                    yield f"data: {json.dumps({'type': 'delta', 'content': text})}\n\n"

                                # Tool call deltas
                                for tc_delta in (delta.get("tool_calls") or []):
                                    idx = tc_delta.get("index", 0)
                                    if idx not in accumulated_tool_calls:
                                        accumulated_tool_calls[idx] = {
                                            "id": tc_delta.get("id", ""),
                                            "type": "function",
                                            "function": {"name": "", "arguments": ""},
                                        }
                                    tc = accumulated_tool_calls[idx]
                                    fn = tc_delta.get("function", {})
                                    if fn.get("name"):
                                        tc["function"]["name"] += fn["name"]
                                    if fn.get("arguments"):
                                        tc["function"]["arguments"] += fn["arguments"]
                                    if tc_delta.get("id"):
                                        tc["id"] = tc_delta["id"]

                except httpx.HTTPStatusError as e:
                    _log.error("[chat/stream] AI provider error status=%s body=%s", e.response.status_code, e.response.text[:500])
                    yield f"data: {json.dumps({'type': 'error', 'detail': f'AI provider {e.response.status_code}: {e.response.text[:200]}'})}\n\n"
                    return
                except Exception as e:
                    yield f"data: {json.dumps({'type': 'error', 'detail': str(e)})}\n\n"
                    return

            # Build the assistant message from accumulated data
            assistant_msg: Dict[str, Any] = {"role": "assistant", "content": accumulated_content or None}
            tool_calls_list = list(accumulated_tool_calls.values())
            if tool_calls_list:
                assistant_msg["tool_calls"] = tool_calls_list

            new_messages.append(assistant_msg)

            # If no tool calls, we're done
            if not tool_calls_list:
                break

            # Persist the assistant message (with tool_calls) once per iteration,
            # before executing the tool calls, so it survives a client abort.
            await deps.db_client.append_chat_message(session_id, assistant_msg)

            # Execute tool calls — run_script/run_katana/run_ffuf stream chunks; others execute atomically
            for tc in tool_calls_list:
                fn_name = tc["function"]["name"]
                try:
                    fn_args_raw = json.loads(tc["function"].get("arguments", "{}"))
                except json.JSONDecodeError:
                    fn_args_raw = {}
                yield f"data: {json.dumps({'type': 'tool_start', 'name': fn_name, 'args': tc['function'].get('arguments', '{}')})}\n\n"

                if fn_name == "run_script":
                    _streamer = stream_run_script(fn_args_raw, project_id=project_id, session_id=session_id)
                elif fn_name == "run_katana":
                    _streamer = stream_run_katana(fn_args_raw)
                elif fn_name == "run_ffuf":
                    _streamer = stream_run_ffuf(fn_args_raw)
                else:
                    _streamer = None

                if _streamer is not None:
                    tool_result = ""
                    async for _chunk, _is_final, _final_result in _streamer:
                        if _is_final:
                            tool_result = _final_result or ""
                        elif _chunk:
                            yield f"data: {json.dumps({'type': 'tool_output_chunk', 'name': fn_name, 'chunk': _chunk})}\n\n"
                else:
                    _t0 = _time.monotonic()
                    # Collect tool outputs already accumulated in this iteration
                    # so that create_finding can validate evidence against them.
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
                # Persist each tool result immediately so it survives a client abort.
                await deps.db_client.append_chat_message(session_id, tool_msg)

        # Persist the final assistant message (no tool calls — loop ended naturally).
        # assistant_msg is only persisted inside the loop when it has tool_calls;
        # the terminal assistant message (role=assistant, no tool_calls) is not yet
        # in the DB, so we persist it here.
        if new_messages and new_messages[-1].get("role") == "assistant" and not new_messages[-1].get("tool_calls"):
            await deps.db_client.append_chat_message(session_id, new_messages[-1])

        updated = await deps.db_client.get_chat_history(session_id)
        yield f"data: {json.dumps({'type': 'done', 'messages': updated})}\n\n"

    return StreamingResponse(_generate(), media_type="text/event-stream")

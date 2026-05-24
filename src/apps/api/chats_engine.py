"""
Unified Agentic Loop & Tool Execution Engine.
"""

import json
import logging
import time as _time
from datetime import datetime, timezone
from typing import AsyncGenerator, Dict, Any, List, Optional

import deps
from routers.chats_tools import resolve_tools
from routers.chats_runners import stream_run_script, stream_run_ffuf, stream_run_katana, stream_run_nuclei
from routers.chats_ai import (
    _NO_KEY_NOTICE,
    _extract_thinking,
    extract_nonstandard_tool_calls,
    _build_or_messages,
    clean_messages_for_display,
)
import routers.chats_ai_litellm
from routers.chats_execute import execute_tool_call

_log = logging.getLogger(__name__)


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


class AgenticOrchestrator:
    @staticmethod
    async def run_loop(
        session_id: str,
        project_id: str,
        message: str,
        max_tool_calls: int = 10,
        model: Optional[str] = None,
        is_background: bool = False,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Unified agentic orchestration execution loop."""
        try:
            resolved_project_id, _api_key, _ai_cfg, _project = await routers.chats_ai_litellm._resolve_project_and_key(
                session_id, project_id
            )
        except Exception as e:
            from fastapi import HTTPException as _HTTPException
            if isinstance(e, _HTTPException) and e.status_code == 503 and "provisioned key" in str(e.detail):
                _detail = str(e.detail)
                _ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
                await deps.db_client.append_chat_message(
                    session_id, {"role": "user", "content": message, "timestamp": _ts}
                )
                await deps.db_client.append_chat_message(
                    session_id, {"role": "notice", "content": _NO_KEY_NOTICE, "timestamp": _ts}
                )
                if is_background:
                    await deps.db_client.update_hunt_status(session_id, "error")
                yield {"type": "error", "detail": _detail}
                return
            if is_background:
                await deps.db_client.update_hunt_status(session_id, "error")
            raise

        _project_model = (
            (_project.get("default_model") if _project else None)
            or _ai_cfg.get("model")
            or deps.OPENROUTER_MODEL
        )
        resolved_model = model or _project_model

        # Load enabled tools
        _session_record = await deps.db_client.get_chat_session(session_id)
        _enabled_tools_names = (
            _session_record.get("enabled_tools") if _session_record else None
        )
        _tools_for_prompt = resolve_tools(_enabled_tools_names)
        _allowed_tool_names = {t["function"]["name"] for t in _tools_for_prompt}

        # Load history and form messages
        history = await deps.db_client.get_chat_history(session_id)
        or_messages = _build_or_messages(history, message, tools=_tools_for_prompt)

        # Persist user message immediately
        _ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
        await deps.db_client.append_chat_message(
            session_id, {"role": "user", "content": message, "timestamp": _ts}
        )

        new_messages: List[Dict[str, Any]] = []
        max_iterations = max(1, min(50, max_tool_calls))
        _hit_limit = False
        _total_usage: Dict[str, int] = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

        for _iteration in range(max_iterations):
            accumulated_content = ""
            accumulated_tool_calls: List[Dict[str, Any]] = []

            try:
                async for text_delta, tool_calls, _usage in routers.chats_ai_litellm.stream_ai_completion(
                    _ai_cfg,
                    _api_key or "",
                    resolved_model,
                    or_messages + new_messages,
                    tools=_tools_for_prompt or None,
                ):
                    if text_delta:
                        accumulated_content += text_delta
                        yield {"type": "delta", "content": text_delta}
                    if tool_calls:
                        accumulated_tool_calls = tool_calls
                    if _usage:
                        _total_usage["prompt_tokens"] += _usage.get("prompt_tokens", 0)
                        _total_usage["completion_tokens"] += _usage.get("completion_tokens", 0)
                        _total_usage["total_tokens"] += _usage.get("total_tokens", 0)
            except Exception as e:
                _log.error("[chats_engine] LiteLLM error: %s", e)
                if is_background:
                    await deps.db_client.update_hunt_status(session_id, "error")
                yield {"type": "error", "detail": str(e)}
                return

            if accumulated_content:
                _clean_content, _thinking = _extract_thinking(accumulated_content)
                if not accumulated_tool_calls:
                    _ns_tool_calls = extract_nonstandard_tool_calls(accumulated_content)
                    accumulated_tool_calls = _ns_tool_calls
                accumulated_content = _clean_content
                _replace_evt: Dict[str, Any] = {"type": "replace", "content": _clean_content}
                if _thinking:
                    _replace_evt["thinking"] = _thinking
                yield _replace_evt
            else:
                _thinking = None

            assistant_msg: Dict[str, Any] = {
                "role": "assistant",
                "content": accumulated_content or None,
            }
            if accumulated_tool_calls:
                assistant_msg["tool_calls"] = accumulated_tool_calls
            if _thinking:
                assistant_msg["thinking"] = _thinking

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
                yield {"type": "replace", "content": _notice}

            new_messages.append(assistant_msg)

            if not accumulated_tool_calls:
                break

            if _iteration == max_iterations - 1:
                _hit_limit = True
                break

            await deps.db_client.append_chat_message(session_id, assistant_msg)

            for tc in accumulated_tool_calls:
                fn_name = tc["function"]["name"]
                try:
                    fn_args_raw = json.loads(tc["function"].get("arguments", "{}"))
                except json.JSONDecodeError:
                    fn_args_raw = {}

                yield {"type": "tool_start", "name": fn_name, "args": tc["function"].get("arguments", "{}")}

                _exit_code: int | None = None
                if fn_name not in _allowed_tool_names:
                    tool_result = f"[FERRET] Tool '{fn_name}' is disabled for this session."
                    _runtime_ms = 0
                    _exit_code = 1
                    tool_result = _attach_meta(tool_result, _runtime_ms, exit_code=_exit_code)

                elif fn_name == "run_script":
                    _t0 = _time.monotonic()
                    _streamer = stream_run_script(
                        fn_args_raw, project_id=resolved_project_id, session_id=session_id
                    )
                    tool_result = ""
                    async for _chunk, _is_final, _final_result in _streamer:
                        if _is_final:
                            tool_result = _final_result or ""
                        elif _chunk:
                            yield {"type": "tool_output_chunk", "name": fn_name, "chunk": _chunk}
                    _runtime_ms = round((_time.monotonic() - _t0) * 1000)
                    tool_result = _attach_meta(tool_result, _runtime_ms, exit_code=_exit_code)

                elif fn_name == "run_katana":
                    _t0 = _time.monotonic()
                    _streamer = stream_run_katana(fn_args_raw)
                    tool_result = ""
                    async for _chunk, _is_final, _final_result in _streamer:
                        if _is_final:
                            tool_result = _final_result or ""
                        elif _chunk:
                            yield {"type": "tool_output_chunk", "name": fn_name, "chunk": _chunk}
                    _runtime_ms = round((_time.monotonic() - _t0) * 1000)
                    tool_result = _attach_meta(tool_result, _runtime_ms, exit_code=_exit_code)

                elif fn_name == "run_ffuf":
                    _t0 = _time.monotonic()
                    _streamer = stream_run_ffuf(fn_args_raw)
                    tool_result = ""
                    async for _chunk, _is_final, _final_result in _streamer:
                        if _is_final:
                            tool_result = _final_result or ""
                        elif _chunk:
                            yield {"type": "tool_output_chunk", "name": fn_name, "chunk": _chunk}
                    _runtime_ms = round((_time.monotonic() - _t0) * 1000)
                    tool_result = _attach_meta(tool_result, _runtime_ms, exit_code=_exit_code)

                elif fn_name == "run_nuclei":
                    _t0 = _time.monotonic()
                    _streamer = stream_run_nuclei(fn_args_raw)
                    tool_result = ""
                    async for _chunk, _is_final, _final_result in _streamer:
                        if _is_final:
                            tool_result = _final_result or ""
                        elif _chunk:
                            yield {"type": "tool_output_chunk", "name": fn_name, "chunk": _chunk}
                    _runtime_ms = round((_time.monotonic() - _t0) * 1000)
                    tool_result = _attach_meta(tool_result, _runtime_ms, exit_code=_exit_code)

                else:
                    _t0 = _time.monotonic()
                    _recent_outputs = [
                        m.get("content", "") for m in new_messages if m.get("role") == "tool"
                    ]
                    tool_result = await execute_tool_call(
                        tc,
                        project_id=resolved_project_id,
                        session_id=session_id,
                        recent_tool_outputs=_recent_outputs,
                    )
                    _runtime_ms = round((_time.monotonic() - _t0) * 1000)
                    tool_result = _attach_meta(tool_result, _runtime_ms, exit_code=_exit_code)

                tool_msg = {
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "name": fn_name,
                    "content": tool_result,
                }
                yield {"type": "tool_result", "name": fn_name, "content": tool_result}
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
            yield {"type": "notice", "content": _limit_notice}

        if is_background:
            await deps.db_client.update_hunt_status(session_id, "done")
            _log.info("[chats_engine] [hunt] completed session=%s", session_id)

        updated = await deps.db_client.get_chat_history(session_id)
        _done_evt: Dict[str, Any] = {"type": "done", "messages": clean_messages_for_display(updated)}
        if _total_usage["total_tokens"] > 0:
            _done_evt["usage"] = _total_usage
        yield _done_evt

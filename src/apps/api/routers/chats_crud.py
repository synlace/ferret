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
        # Import here to avoid circular imports at module load time
        from chats_tools import SESSION_CHAT_TOOLS, resolve_tools
        from chats_ai import (
            _build_ai_request,
            _parse_ai_response,
            _resolve_project_and_key,
            _build_or_messages,
        )
        from chats_execute import execute_tool_call
        from chats_runners import stream_run_script, stream_run_katana, stream_run_ffuf, stream_run_nuclei

        import httpx

        try:
            resolved_project_id, _api_key, _ai_cfg, _project = await _resolve_project_and_key(
                session_id, project_id
            )
        except Exception as exc:
            _log.error("[hunt] failed to resolve project/key for session=%s: %s", session_id, exc)
            await deps.db_client.update_hunt_status(session_id, "error")
            return

        # Prevention: load the session to honour per-session enabled_tools.
        _session = await deps.db_client.get_chat_session(session_id)
        _enabled_tools_names = _session.get("enabled_tools") if _session else None
        _tools_for_request = resolve_tools(_enabled_tools_names)
        _allowed_tool_names = {t["function"]["name"] for t in _tools_for_request}

        _project_model = (
            (_project.get("default_model") if _project else None)
            or _ai_cfg.get("model")
            or deps.OPENROUTER_MODEL
        )
        _ai_cfg_with_key = {**_ai_cfg, "_resolved_key": _api_key}

        # Persist the initial user message so it appears in the UI
        _ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M")
        await deps.db_client.append_chat_message(
            session_id, {"role": "user", "content": prompt, "timestamp": _ts}
        )

        # Build the initial message list: system prompt + user prompt.
        # Pass _tools_for_request so the system prompt only mentions enabled tools.
        or_messages = _build_or_messages([], prompt, tools=_tools_for_request)

        new_messages = []
        iterations = max(1, min(50, max_tool_calls))

        for _ in range(iterations):
            _url, _headers, _body = _build_ai_request(
                _ai_cfg_with_key, _project_model, or_messages + new_messages, _tools_for_request
            )
            try:
                async with httpx.AsyncClient(timeout=120.0) as client:
                    resp = await client.post(_url, headers=_headers, json=_body)
                    resp.raise_for_status()
                    data = resp.json()
            except Exception as exc:
                _log.error("[hunt] AI provider error for session=%s: %s", session_id, exc)
                await deps.db_client.update_hunt_status(session_id, "error")
                return

            assistant_msg = _parse_ai_response(_ai_cfg_with_key, data)
            new_messages.append(assistant_msg)
            await deps.db_client.append_chat_message(session_id, assistant_msg)

            tool_calls = assistant_msg.get("tool_calls") or []
            if not tool_calls:
                break

            _recent_outputs = [
                m.get("content", "") for m in new_messages if m.get("role") == "tool"
            ]
            for tc in tool_calls:
                fn_name = tc["function"]["name"]
                try:
                    fn_args_raw = json.loads(tc["function"].get("arguments", "{}"))
                except json.JSONDecodeError:
                    fn_args_raw = {}

                # Enforcement: reject calls to tools that are disabled for this session.
                # The LLM must still receive a tool message for every tool_call_id it
                # emitted, otherwise the next API request will be rejected.
                _exit_code: int | None = None
                if fn_name not in _allowed_tool_names:
                    tool_result = f"[FERRET] Tool '{fn_name}' is disabled for this session."
                    _runtime_ms = 0
                    _exit_code = 1
                elif fn_name == "run_script":
                    _t0 = _time.monotonic()
                    _streamer = stream_run_script(fn_args_raw, project_id=resolved_project_id, session_id=session_id)
                    tool_result = ""
                    async for _chunk, _is_final, _final_result in _streamer:
                        if _is_final:
                            tool_result = _final_result or ""
                    _runtime_ms = round((_time.monotonic() - _t0) * 1000)
                elif fn_name == "run_katana":
                    _t0 = _time.monotonic()
                    _streamer = stream_run_katana(fn_args_raw)
                    tool_result = ""
                    async for _chunk, _is_final, _final_result in _streamer:
                        if _is_final:
                            tool_result = _final_result or ""
                    _runtime_ms = round((_time.monotonic() - _t0) * 1000)
                elif fn_name == "run_ffuf":
                    _t0 = _time.monotonic()
                    _streamer = stream_run_ffuf(fn_args_raw)
                    tool_result = ""
                    async for _chunk, _is_final, _final_result in _streamer:
                        if _is_final:
                            tool_result = _final_result or ""
                    _runtime_ms = round((_time.monotonic() - _t0) * 1000)
                elif fn_name == "run_nuclei":
                    _t0 = _time.monotonic()
                    _streamer = stream_run_nuclei(fn_args_raw)
                    tool_result = ""
                    async for _chunk, _is_final, _final_result in _streamer:
                        if _is_final:
                            tool_result = _final_result or ""
                    _runtime_ms = round((_time.monotonic() - _t0) * 1000)
                else:
                    _t0 = _time.monotonic()
                    tool_result = await execute_tool_call(
                        tc,
                        project_id=resolved_project_id,
                        session_id=session_id,
                        recent_tool_outputs=_recent_outputs,
                    )
                    _runtime_ms = round((_time.monotonic() - _t0) * 1000)
                # Attach __META__ timing inline (mirrors chats.py _attach_meta)
                _meta_prefix = "\n__META__:"
                _meta_idx = tool_result.rfind(_meta_prefix)
                if _meta_idx != -1:
                    try:
                        _existing = json.loads(tool_result[_meta_idx + len(_meta_prefix):])
                    except Exception:
                        _existing = {}
                    _existing["runtime_ms"] = _runtime_ms
                    if _exit_code is not None:
                        _existing["exit_code"] = _exit_code
                    tool_result = tool_result[:_meta_idx] + _meta_prefix + json.dumps(_existing)
                else:
                    _meta: dict = {"runtime_ms": _runtime_ms}
                    if _exit_code is not None:
                        _meta["exit_code"] = _exit_code
                    tool_result = tool_result + _meta_prefix + json.dumps(_meta)

                tool_msg = {
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "name": fn_name,
                    "content": tool_result,
                }
                new_messages.append(tool_msg)
                await deps.db_client.append_chat_message(session_id, tool_msg)

        await deps.db_client.update_hunt_status(session_id, "done")
        _log.info("[hunt] completed session=%s", session_id)

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

"""
Request history, annotation, and per-request chat endpoints.
"""

import asyncio
import json
import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from typing import List, Optional, Dict, Any

import deps
from models import HttpRequest, ChatSendRequest

router = APIRouter()


# ---------------------------------------------------------------------------
# Request history
# ---------------------------------------------------------------------------

@router.get("/api/requests")
async def get_requests(
    limit: int = 50,
    offset: int = 0,
    method: Optional[str] = None,
    status_code: Optional[int] = None,
    host: Optional[str] = None,
    search: Optional[str] = None,
    source: Optional[str] = None,
    project_id: str = "temp",
):
    """Get HTTP requests history with filtering. Returns X-Total-Count header for pagination."""
    try:
        rows, total = await asyncio.gather(
            deps.db_client.search_requests(
                limit=limit,
                offset=offset,
                method=method,
                status_code=status_code,
                host=host,
                search=search,
                source=source,
                project_id=project_id,
            ),
            deps.db_client.count_requests(
                method=method,
                status_code=status_code,
                host=host,
                search=search,
                source=source,
                project_id=project_id,
            ),
        )
        data = [r.model_dump(mode="json") for r in rows]
        return JSONResponse(
            content=data,
            headers={"X-Total-Count": str(total), "Access-Control-Expose-Headers": "X-Total-Count"},
        )
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/requests/stats")
async def get_request_stats(project_id: str = "temp"):
    """Get request statistics."""
    try:
        return await deps.db_client.get_stats(project_id=project_id)
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/requests")
async def clear_requests(project_id: str = "temp"):
    """Delete all captured requests and their associated chat histories."""
    try:
        deleted = await deps.db_client.clear_all_requests(project_id=project_id)
        return {"ok": True, "deleted": deleted}
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/requests/{request_id}", response_model=HttpRequest)
async def get_request(request_id: str):
    """Get specific HTTP request by ID."""
    try:
        request = await deps.db_client.get_request(request_id)
        if not request:
            raise HTTPException(status_code=404, detail="Request not found")
        return request
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


# ---------------------------------------------------------------------------
# Annotate
# ---------------------------------------------------------------------------

@router.post("/api/requests/{request_id}/annotate")
async def annotate_request(request_id: str):
    """
    Ask OpenRouter to write a brief plain-English annotation for the captured
    HTTP request and persist it in the database.
    Uses the provisioned key for the request's project (default: temp).
    Model resolution: project.default_model → deps.OPENROUTER_MODEL (env fallback).
    """
    req = await deps.db_client.get_request(request_id)
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")

    # Resolve project for this request
    async with deps.db_client._db.execute(
        "SELECT project_id FROM requests WHERE id = ?", (request_id,)
    ) as _cur:
        _row = await _cur.fetchone()
    _req_project_id = (_row["project_id"] if _row and _row["project_id"] else "temp")

    _api_key = await deps.get_key_for_project(_req_project_id)
    if not _api_key:
        raise HTTPException(
            status_code=503,
            detail=f"No provisioned key for project '{_req_project_id}'. Add one via Projects → Keys.",
        )

    # Resolve model: project default_model → global env fallback
    _project = await deps.db_client.get_project(_req_project_id)
    _model = (
        (_project.get("default_model") if _project else None)
        or deps.OPENROUTER_MODEL
    )

    method = req.method.value if hasattr(req.method, "value") else req.method
    header_lines = "\n".join(
        f"  {k}: {v}" for k, v in (req.headers or {}).items()
        if k.lower() not in ("cookie", "authorization")
    )
    body_preview = (req.body or "")[:500]
    if req.body and len(req.body) > 500:
        body_preview += f"\n  ... ({len(req.body) - 500} bytes truncated)"

    prompt = (
        "You are a security analyst reviewing intercepted HTTP traffic.\n"
        "Write a single concise sentence (max 25 words) that describes what this request does "
        "and any obvious security concerns. Be direct and technical.\n\n"
        f"Request:\n"
        f"  {method} {req.url}\n"
        f"  Host: {req.host}\n"
        f"  Headers:\n{header_lines}\n"
        f"  Body: {body_preview or '(empty)'}\n"
        f"  Response status: {req.status_code or 'pending'}"
    )

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=deps.openrouter_headers(_api_key),
                json={
                    "model": _model,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 80,
                },
            )
            r.raise_for_status()
            annotation: str = r.json()["choices"][0]["message"]["content"].strip()
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"OpenRouter {e.response.status_code}: {e.response.text[:200]}")
    except Exception as e:
        raise HTTPException(502, f"OpenRouter failed: {e}")

    await deps.db_client.set_annotation(request_id, annotation)
    return {"annotation": annotation}


# ---------------------------------------------------------------------------
# Per-request chat — agentic loop with tool-calling
# ---------------------------------------------------------------------------

_CHAT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "write_and_run_tests",
            "description": (
                "Write Python pytest code to the test file for this request and immediately "
                "execute it. Returns the raw pytest output. Call this whenever you want to "
                "create or update the test suite."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Complete Python pytest source code to write to the test file.",
                    }
                },
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_tests",
            "description": "Run the existing test file without modifying it. Returns pytest output.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_test_file",
            "description": "Read the current contents of the test file.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]


@router.get("/api/requests/{request_id}/chat")
async def get_chat(request_id: str):
    """
    Return the persisted chat history for a request.
    Returns { messages: [...], test_file: str | null }
    """
    req = await deps.db_client.get_request(request_id)
    if not req:
        raise HTTPException(404, "Request not found")
    messages = await deps.db_client.get_chat_messages(request_id)
    test_path = deps.test_file_path(request_id, req.host)
    test_file = str(test_path) if test_path.exists() else None
    return {"messages": messages, "test_file": test_file}


@router.delete("/api/requests/{request_id}/chat")
async def clear_chat(request_id: str):
    """Delete all chat messages for a request."""
    req = await deps.db_client.get_request(request_id)
    if not req:
        raise HTTPException(404, "Request not found")
    await deps.db_client.clear_chat_messages(request_id)
    return {"ok": True}


@router.post("/api/requests/{request_id}/chat")
async def chat(request_id: str, body: ChatSendRequest):
    """
    Agentic chat endpoint.  The client sends only the new user message text.
    The server loads the full conversation history from the DB, appends the
    system prompt + new user message, calls OpenRouter (with tool-calling),
    executes any tool calls, persists all new messages, and returns them.
    Model resolution: body.model → project.default_model → deps.OPENROUTER_MODEL.
    """
    req = await deps.db_client.get_request(request_id)
    if not req:
        raise HTTPException(404, "Request not found")

    # Determine project_id from request row — fall back to "temp"
    async with deps.db_client._db.execute(
        "SELECT project_id FROM requests WHERE id = ?", (request_id,)
    ) as _cur:
        _row = await _cur.fetchone()
    _req_project_id = (_row["project_id"] if _row and _row["project_id"] else "temp")

    _api_key = await deps.get_key_for_project(_req_project_id)
    if not _api_key:
        raise HTTPException(503, f"No provisioned key for project '{_req_project_id}'. Add one via Projects → Keys.")

    # Resolve model: per-call override → project default_model → global env fallback
    _project = await deps.db_client.get_project(_req_project_id)
    _project_model = (_project.get("default_model") if _project else None) or deps.OPENROUTER_MODEL
    _model = body.model or _project_model

    method = req.method.value if hasattr(req.method, "value") else req.method
    header_lines = "\n".join(
        f"  {k}: {v}" for k, v in (req.headers or {}).items()
        if k.lower() not in ("cookie", "authorization")
    )
    body_preview = (req.body or "")[:800]
    if req.body and len(req.body) > 800:
        body_preview += f"\n  ... ({len(req.body) - 800} bytes truncated)"
    test_path = deps.test_file_path(request_id, req.host)

    system_prompt = (
        "You are an expert application security engineer embedded in a proxy tool called FERRET.\n"
        "You are analysing a specific intercepted HTTP request. Your job is to help the user "
        "understand the security posture of this endpoint — write tests, run them, interpret "
        "results, and suggest fixes.\n\n"
        "You have three tools available:\n"
        "  • write_and_run_tests(code) — write pytest code to disk and run it immediately.\n"
        "  • run_tests() — re-run the existing test file.\n"
        "  • read_test_file() — read the current test file.\n\n"
        "Test files are written to a host-mounted directory so the user can also run them "
        "independently with `pytest`.\n\n"
        f"Test file path (inside container): {test_path}\n\n"
        "--- INTERCEPTED REQUEST ---\n"
        f"{method} {req.url}\n"
        f"Host: {req.host}\n"
        f"Headers:\n{header_lines}\n"
        f"Body:\n{body_preview or '(empty)'}\n"
        f"Response status: {req.status_code or 'pending'}\n"
    )

    history = await deps.db_client.get_chat_messages(request_id)
    user_msg: Dict[str, Any] = {"role": "user", "content": body.message}
    await deps.db_client.save_chat_messages(request_id, [user_msg])

    or_messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for m in history:
        msg: Dict[str, Any] = {"role": m["role"], "content": m.get("content") or ""}
        if m.get("tool_call_id"):
            msg["tool_call_id"] = m["tool_call_id"]
        if m.get("name"):
            msg["name"] = m["name"]
        if m.get("tool_calls"):
            msg["tool_calls"] = m["tool_calls"]
        or_messages.append(msg)
    or_messages.append(user_msg)

    new_messages: List[Dict[str, Any]] = []
    max_iterations = 5

    for _ in range(max_iterations):
        try:
            async with httpx.AsyncClient(timeout=90.0) as client:
                resp = await client.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers=deps.openrouter_headers(_api_key),
                    json={
                        "model": _model,
                        "messages": or_messages + new_messages,
                        "tools": _CHAT_TOOLS,
                        "tool_choice": "auto",
                        "max_tokens": 2048,
                    },
                )
                resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise HTTPException(502, f"OpenRouter {e.response.status_code}: {e.response.text[:200]}")
        except Exception as e:
            raise HTTPException(502, f"OpenRouter failed: {e}")

        choice = resp.json()["choices"][0]
        assistant_msg = choice["message"]
        new_messages.append(assistant_msg)

        tool_calls = assistant_msg.get("tool_calls") or []
        if not tool_calls:
            break

        for tc in tool_calls:
            fn_name = tc["function"]["name"]
            try:
                fn_args = json.loads(tc["function"].get("arguments", "{}"))
            except json.JSONDecodeError:
                fn_args = {}

            tool_result: str

            if fn_name == "write_and_run_tests":
                code = deps.strip_fences(fn_args.get("code", ""))
                try:
                    test_path.write_text(code, encoding="utf-8")
                    tool_result = await deps.run_pytest(test_path)
                except Exception as exc:
                    tool_result = f"[FERRET] Error: {exc}"

            elif fn_name == "run_tests":
                if test_path.exists():
                    tool_result = await deps.run_pytest(test_path)
                else:
                    tool_result = "[FERRET] No test file exists yet. Use write_and_run_tests first."

            elif fn_name == "read_test_file":
                if test_path.exists():
                    tool_result = test_path.read_text(encoding="utf-8")
                else:
                    tool_result = "[FERRET] No test file exists yet."

            else:
                tool_result = f"[FERRET] Unknown tool: {fn_name}"

            new_messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "name": fn_name,
                "content": tool_result,
            })

    await deps.db_client.save_chat_messages(request_id, new_messages)
    test_file = str(test_path) if test_path.exists() else None
    return {"messages": new_messages, "test_file": test_file}

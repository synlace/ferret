"""
Chat session endpoints (multi-chat, not per-request).
"""

import re
import uuid
import json
import httpx
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from typing import List, Dict, Any, Optional

import deps
from models import ChatSession, ChatSessionCreate, ChatSessionUpdate, ChatSendRequest

_log = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Session CRUD
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Agentic tools available in session chat
# ---------------------------------------------------------------------------

_SESSION_CHAT_TOOLS = [
    # -----------------------------------------------------------------------
    # Proxy history tools
    # -----------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "search_requests",
            "description": (
                "Search the proxy request history by keyword. "
                "Returns a list of matching requests (method, URL, status). "
                "Use this first to discover what endpoints exist."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Keyword to match against URL, host, or body. Leave empty to list all.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results to return (default 20).",
                        "default": 20,
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_request_detail",
            "description": (
                "Fetch the full details of a single HTTP request by its ID, "
                "including request headers, body, response headers, and response body. "
                "Use this to inspect a specific request before writing a test."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "request_id": {
                        "type": "string",
                        "description": "The request ID (from search_requests results).",
                    },
                },
                "required": ["request_id"],
            },
        },
    },
    # -----------------------------------------------------------------------
    # Findings tools
    # -----------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "create_finding",
            "description": (
                "Create a security finding in the FERRET findings database. "
                "Use this when you have confirmed or strongly suspected a vulnerability. "
                "Returns the created finding ID."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short title, e.g. 'SQL Injection in /api/login'.",
                    },
                    "severity": {
                        "type": "string",
                        "enum": ["critical", "high", "medium", "low", "info"],
                        "description": "Severity level.",
                    },
                    "type": {
                        "type": "string",
                        "enum": ["sqli", "xss", "idor", "auth", "config", "other"],
                        "description": "Vulnerability type.",
                        "default": "other",
                    },
                    "host": {
                        "type": "string",
                        "description": "Affected host, e.g. 'example.com'.",
                    },
                    "description": {
                        "type": "string",
                        "description": "Detailed description of the vulnerability.",
                    },
                    "evidence": {
                        "type": "string",
                        "description": "Evidence or proof-of-concept (request/response snippets, test output).",
                    },
                    "request_id": {
                        "type": "string",
                        "description": "Optional: ID of the associated proxy request.",
                    },
                },
                "required": ["title", "severity", "host", "description"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_findings",
            "description": (
                "List existing security findings for the current project. "
                "Use this to avoid creating duplicate findings and to reference prior work."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "severity": {
                        "type": "string",
                        "enum": ["critical", "high", "medium", "low", "info"],
                        "description": "Filter by severity (optional).",
                    },
                    "status": {
                        "type": "string",
                        "enum": ["open", "confirmed", "false_positive", "fixed"],
                        "description": "Filter by status (optional).",
                    },
                },
                "required": [],
            },
        },
    },
    # -----------------------------------------------------------------------
    # Test execution tools
    # -----------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "write_test",
            "description": (
                "Write a complete Python pytest file to disk and immediately execute it. "
                "Returns the raw pytest output. Use this to create structured, reusable "
                "security tests for endpoints discovered in the proxy history."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "Filename for the test file, e.g. test_login_sqli.py",
                    },
                    "code": {
                        "type": "string",
                        "description": "Complete Python pytest source code.",
                    },
                },
                "required": ["filename", "code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_test",
            "description": "Run an existing pytest file by filename. Returns pytest output.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "Filename of the test to run.",
                    }
                },
                "required": ["filename"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_test",
            "description": (
                "Read the current contents of an existing pytest file. "
                "Use this before modifying a test — read it first, fix only the broken part, "
                "then overwrite it with write_test using the SAME filename. "
                "Never create _v2, _v3 variants — always reuse the original filename."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "Filename of the test file to read, e.g. test_ws_xss.py",
                    }
                },
                "required": ["filename"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "pip_install",
            "description": (
                "Install one or more Python packages into the ferret-lab sandbox environment "
                "using pip3. Use this when a test fails with ModuleNotFoundError. "
                "Packages persist in the sandbox until it is restarted. "
                "Prefer packages already available (requests, httpx, websockets, "
                "websocket-client, pytest, paramiko, cryptography). "
                "Only use this when a ModuleNotFoundError occurs."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "packages": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of package names to install, e.g. ['websocket-client', 'paramiko']",
                    }
                },
                "required": ["packages"],
            },
        },
    },
    # -----------------------------------------------------------------------
    # Script execution tool
    # -----------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "run_script",
            "description": (
                "Write and execute an arbitrary bash or Python script in the ferret-lab sandbox. "
                "Use this to run exploit PoCs, custom scanners, or any shell command that "
                "doesn't fit into write_pytest_file. "
                "The script runs inside the sandbox container with network access. "
                "stdout + stderr are returned (truncated to 8 KB). "
                "For Python scripts use interpreter='python3'; for shell use interpreter='bash'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "interpreter": {
                        "type": "string",
                        "enum": ["bash", "python3"],
                        "description": "Interpreter to use: 'bash' or 'python3'.",
                    },
                    "script": {
                        "type": "string",
                        "description": "Full script source code to execute.",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Execution timeout in seconds (default 30, max 120).",
                    },
                },
                "required": ["interpreter", "script"],
            },
        },
    },
    # -----------------------------------------------------------------------
    # katana web crawler — preferred for endpoint/directory discovery
    # -----------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "run_katana",
            "description": (
                "Crawl a web application to discover endpoints, paths, forms, and linked resources. "
                "PREFER this over run_ffuf for directory/file/endpoint discovery — katana follows "
                "real links and parses JavaScript, finding routes that wordlist fuzzing misses. "
                "Use run_ffuf only for parameter fuzzing, credential brute-forcing, or SQLi fuzzing.\n"
                "Results are truncated to 16 KB."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Seed URL to start crawling from, e.g. 'https://target.com'.",
                    },
                    "depth": {
                        "type": "integer",
                        "description": "Crawl depth (default 3, max 10).",
                    },
                    "js_crawl": {
                        "type": "boolean",
                        "description": "Parse JavaScript files for additional endpoints (default true).",
                    },
                    "headless": {
                        "type": "boolean",
                        "description": (
                            "Use headless Chrome to render JS-heavy SPAs before crawling "
                            "(default false — slower but finds dynamically-rendered routes)."
                        ),
                    },
                    "scope": {
                        "type": "string",
                        "description": (
                            "Restrict crawl to URLs matching this regex. "
                            "Defaults to the seed domain. Use '.*' to crawl out-of-scope links."
                        ),
                    },
                    "proxy": {
                        "type": "string",
                        "description": "Proxy URL (default 'http://api:1337' to route through FERRET).",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Total execution timeout in seconds (default 60, max 300).",
                    },
                    "extra_args": {
                        "type": "string",
                        "description": (
                            "Additional raw katana flags, e.g. '-form-extraction' or '-known-files all'. "
                            "Do NOT include -u, -d, -proxy, -js-crawl, -headless (use dedicated params)."
                        ),
                    },
                },
                "required": ["url"],
            },
        },
    },
    # -----------------------------------------------------------------------
    # ffuf parameter/credential/SQLi fuzzer (NOT for directory discovery)
    # -----------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "run_ffuf",
            "description": (
                "Run ffuf (Fuzz Faster U Fool) inside the ferret-lab sandbox for parameter fuzzing, "
                "credential brute-forcing, vhost discovery, or SQLi fuzzing. "
                "NOT intended for directory/file discovery — use run_katana for that instead. "
                "Place the FUZZ keyword anywhere in the URL, headers, or POST data. "
                "Returns a summary of matches with status codes, sizes, and response times. "
                "Available wordlists inside the sandbox:\n"
                "  /usr/share/dirb/wordlists/common.txt  (default, ~4600 entries, fast)\n"
                "  /usr/share/dirb/wordlists/big.txt  (~20000 entries)\n"
                "  /usr/share/seclists/Discovery/Web-Content/common.txt\n"
                "  /usr/share/seclists/Discovery/Web-Content/directory-list-2.3-medium.txt\n"
                "  /usr/share/seclists/Discovery/Web-Content/raft-medium-directories.txt\n"
                "  /usr/share/seclists/Discovery/Web-Content/raft-large-files.txt\n"
                "  /usr/share/seclists/Discovery/Web-Content/api/api-endpoints.txt\n"
                "  /usr/share/seclists/Discovery/DNS/subdomains-top1million-5000.txt\n"
                "  /usr/share/seclists/Usernames/top-usernames-shortlist.txt\n"
                "  /usr/share/seclists/Passwords/Common-Credentials/10-million-password-list-top-10000.txt\n"
                "  /usr/share/seclists/Fuzzing/SQLi/Generic-SQLi.txt\n"
                "Results are truncated to 16 KB."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": (
                            "Target URL with FUZZ placeholder, e.g. "
                            "'https://example.com/FUZZ' or 'https://example.com/api/FUZZ.php'."
                        ),
                    },
                    "wordlist": {
                        "type": "string",
                        "description": (
                            "Absolute path to wordlist inside the sandbox. "
                            "Defaults to /usr/share/dirb/wordlists/common.txt."
                        ),
                    },
                    "method": {
                        "type": "string",
                        "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
                        "description": "HTTP method (default GET).",
                    },
                    "headers": {
                        "type": "object",
                        "description": "Extra request headers as key-value pairs.",
                    },
                    "data": {
                        "type": "string",
                        "description": "POST body data (use FUZZ as placeholder for fuzzing).",
                    },
                    "match_codes": {
                        "type": "string",
                        "description": (
                            "Comma-separated HTTP status codes to match, e.g. '200,301,302,403'. "
                            "Defaults to '200,204,301,302,307,401,403,405,500'."
                        ),
                    },
                    "filter_codes": {
                        "type": "string",
                        "description": "Comma-separated HTTP status codes to filter out (hide from results).",
                    },
                    "filter_size": {
                        "type": "string",
                        "description": "Filter responses by size, e.g. '0' to hide empty responses.",
                    },
                    "threads": {
                        "type": "integer",
                        "description": "Number of concurrent threads (default 40, max 100).",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Total execution timeout in seconds (default 60, max 300).",
                    },
                    "extra_args": {
                        "type": "string",
                        "description": (
                            "Additional raw ffuf flags, e.g. '-recursion -recursion-depth 2' "
                            "or '-H \"Host: FUZZ.example.com\"' for vhost fuzzing. "
                            "Do NOT include -u, -w, -X, -d, -H (use the dedicated params instead)."
                        ),
                    },
                },
                "required": ["url"],
            },
        },
    },
    # -----------------------------------------------------------------------
    # Direct HTTP request tool
    # -----------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "http_request",
            "description": (
                "Send a single HTTP request directly and return the status code, "
                "response headers, and response body. Use this for quick interactive "
                "probing of endpoints — e.g. to test a payload or confirm a vulnerability — "
                "without writing a full pytest file. "
                "Requests are routed through the FERRET proxy (port 1337) by default so they "
                "appear in the request history. "
                "Use write_pytest_file only once you have a confirmed finding to codify."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "method": {
                        "type": "string",
                        "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
                        "description": "HTTP method.",
                    },
                    "url": {
                        "type": "string",
                        "description": "Full URL including scheme, e.g. https://example.com/api/login",
                    },
                    "headers": {
                        "type": "object",
                        "description": "Optional request headers as key-value pairs.",
                    },
                    "body": {
                        "type": "string",
                        "description": "Optional request body (raw string).",
                    },
                    "content_type": {
                        "type": "string",
                        "description": (
                            "Content-Type header value, e.g. 'application/json', "
                            "'application/x-www-form-urlencoded', or 'application/xml'."
                        ),
                    },
                    "via_proxy": {
                        "type": "boolean",
                        "description": (
                            "If true (default), route through FERRET proxy on 127.0.0.1:1337 "
                            "so the request appears in history."
                        ),
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Request timeout in seconds (default 15).",
                    },
                },
                "required": ["method", "url"],
            },
        },
    },
]

# Inject a required `rationale` field into every tool so the model always
# explains why it is calling the tool. This appears in the UI as a sub-panel.
_RATIONALE_PROP = {
    "type": "string",
    "description": "One sentence explaining why you are calling this tool right now.",
}
for _t in _SESSION_CHAT_TOOLS:
    _props = _t["function"]["parameters"]["properties"]
    _props["rationale"] = _RATIONALE_PROP
    _req: list = _t["function"]["parameters"].setdefault("required", [])
    if "rationale" not in _req:
        _req.insert(0, "rationale")


# ---------------------------------------------------------------------------
# Provider-aware AI call helpers
# ---------------------------------------------------------------------------

def _build_ai_request(ai_cfg: dict, model: str, messages: list, tools: list) -> tuple[str, dict, dict]:
    """Return (url, headers, json_body) for a chat completions call.

    Handles both OpenAI-compatible providers and Anthropic direct.
    """
    fmt      = ai_cfg.get("format", "openai")
    base_url = ai_cfg.get("base_url", "https://openrouter.ai/api/v1").rstrip("/")
    api_key  = ai_cfg.get("_resolved_key", "")  # injected by caller

    if fmt == "anthropic":
        url = base_url + "/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        # Anthropic separates system prompt from messages
        system_msg = next((m["content"] for m in messages if m["role"] == "system"), None)
        user_msgs  = [m for m in messages if m["role"] != "system"]
        body: dict = {
            "model": model,
            "max_tokens": 8096,
            "messages": user_msgs,
        }
        if system_msg:
            body["system"] = system_msg
        if tools:
            # Convert OpenAI tool schema to Anthropic tool schema
            body["tools"] = [
                {
                    "name": t["function"]["name"],
                    "description": t["function"].get("description", ""),
                    "input_schema": t["function"].get("parameters", {}),
                }
                for t in tools
            ]
    else:
        url = base_url + "/chat/completions"
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        body = {
            "model": model,
            "messages": messages,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"

    return url, headers, body


def _parse_ai_response(ai_cfg: dict, data: dict) -> dict:
    """Normalise a provider response to an OpenAI-style assistant message dict."""
    fmt = ai_cfg.get("format", "openai")
    if fmt == "anthropic":
        # Anthropic response: {"content": [{"type": "text", "text": "..."}, ...], "stop_reason": ...}
        text_parts = [b["text"] for b in data.get("content", []) if b.get("type") == "text"]
        tool_uses  = [b for b in data.get("content", []) if b.get("type") == "tool_use"]
        msg: dict = {"role": "assistant", "content": "\n".join(text_parts)}
        if tool_uses:
            msg["tool_calls"] = [
                {
                    "id": tu["id"],
                    "type": "function",
                    "function": {"name": tu["name"], "arguments": json.dumps(tu.get("input", {}))},
                }
                for tu in tool_uses
            ]
        return msg
    else:
        return data["choices"][0]["message"]


async def _resolve_project_and_key(session_id: str, fallback_project_id: str):
    """Return (project_id, api_key, ai_config, project_row) for a session.

    Key resolution order (see deps.get_key_for_project):
    1. Provisioned per-project sub-key (OpenRouter provisioning flow).
    2. Global API key saved by the setup wizard.
    3. Raises 503 if neither is available.

    The returned ``ai_config`` dict contains the active provider, base_url,
    format, and model so callers can route to the correct endpoint.
    """
    _session = await deps.db_client.get_chat_session(session_id)
    project_id = ((_session.get("project_id") if _session else None) or fallback_project_id)
    _log.info("[chat] session=%s resolved project_id=%s", session_id, project_id)

    api_key = await deps.get_key_for_project(project_id)
    if not api_key:
        raise HTTPException(
            503,
            f"No provisioned key for project '{project_id}'. "
            "Configure a provider via Setup, or add a provisioned key via Projects → Keys."
        )

    ai_cfg = deps.get_ai_config()
    _log.info("[chat] using key prefix=%s... for project=%s provider=%s",
              (api_key[:16] if api_key else "NONE"), project_id, ai_cfg.get("provider"))
    project = await deps.db_client.get_project(project_id)
    return project_id, api_key, ai_cfg, project


_NO_KEY_NOTICE = (
    "**No API key configured for this project.**\n\n"
    "Go to **Projects → Keys → Create Key** to provision one, "
    "then come back and send your message."
)


def _build_or_messages(history: List[Dict[str, Any]], new_user_message: str) -> List[Dict[str, Any]]:
    system_prompt = (
        "You are a security testing assistant in FERRET (a MITM proxy tool). "
        "Be concise. Use Markdown: code blocks for code, bullets for findings.\n\n"

        "Grounding rules (CRITICAL — read before every response):\n"
        "0. NEVER claim success, failure, or any outcome unless the tool output explicitly "
        "confirms it. If a script prints 'Lab not solved yet', the lab is NOT solved — "
        "do not write a summary claiming it is.\n"
        "1. After every run_script or run_test call, read the ACTUAL stdout/stderr output "
        "before deciding what to do next. Do not assume the outcome.\n"
        "2. HTTP 200 from a checkout or action endpoint means the page rendered — it does "
        "NOT mean the action succeeded. Only a 302 redirect or an explicit success string "
        "in the response body confirms success.\n"
        "3. The evidence field in create_finding MUST be copied verbatim from tool output. "
        "Never write evidence that was not returned by a tool in this session.\n"
        "4. If a verification script returns a negative result (e.g. 'not solved', "
        "'Insufficient funds', 'error'), acknowledge the failure and retry with a "
        "corrected approach. Do not repeat the same claim.\n\n"

        "run_script session rules:\n"
        "5. Each run_script call runs in a FRESH Python process — requests.Session() objects "
        "do NOT persist between calls. To maintain cookies/auth across multiple scripts, "
        "use the injected `session` variable (automatically persisted to disk between calls "
        "within this chat session). Do NOT create a new `session = requests.Session()` — "
        "the persistent session is already available as `session`.\n\n"

        "Tool call rules:\n"
        "0. Always set the 'rationale' field to one sentence explaining why you are calling the tool.\n"
        "Discovery rule: Use run_katana to discover endpoints, directories, and files on a target. "
        "Only use run_ffuf for parameter fuzzing, credential brute-forcing, or SQLi fuzzing — "
        "never for directory/file discovery.\n\n"
        "pytest rules:\n"
        "1. Always add `verify=False` to every request and `import urllib3; urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)` at the top.\n"
        "2. Proxy address: `proxies={'https': 'http://api:1337', 'http': 'http://api:1337'}`. Never use 127.0.0.1 or localhost.\n"
        "3. ModuleNotFoundError → pip_install, then re-run the SAME file. Never create _v2/_v3 variants.\n"
        "4. Other failures → read_pytest_file, fix in place, overwrite with the SAME filename."
    )
    or_messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for m in history:
        # Skip UI-only notice messages — not a valid AI role; sending them to the
        # provider would cause a 400/422 error.
        if m.get("role") == "notice":
            continue
        msg: Dict[str, Any] = {"role": m["role"], "content": m.get("content") or ""}
        if m.get("tool_call_id"):
            msg["tool_call_id"] = m["tool_call_id"]
        if m.get("name"):
            msg["name"] = m["name"]
        if m.get("tool_calls"):
            msg["tool_calls"] = m["tool_calls"]
        or_messages.append(msg)
    or_messages.append({"role": "user", "content": new_user_message})
    return or_messages


# ── Streaming subprocess helpers ─────────────────────────────────────────────
# Each generator yields (chunk: str, is_final: bool, final_result: str | None).
# While is_final is False, chunk is a raw output chunk to stream to the client.
# When is_final is True, final_result is the complete result string (with __META__).

# ---------------------------------------------------------------------------
# Persistent session preamble injected at the top of every python3 run_script.
#
# Problem: each run_script call spawns a fresh Python process, so
# requests.Session() objects — and their cookies — are lost between calls.
# This causes multi-step exploits (e.g. overflow cart → checkout) to fail
# because the second script starts with an empty, unauthenticated session.
#
# Solution: inject a preamble that loads a pickled requests.Session from a
# per-chat-session file in /tmp inside the sandbox container.  The session is
# saved back to disk via atexit so it persists across run_script calls.
# The model is instructed (in the system prompt) to use the pre-built `session`
# variable rather than creating a new one.
# ---------------------------------------------------------------------------

_PYTHON_SESSION_PREAMBLE_TEMPLATE = """\
# [FERRET] Persistent session preamble — do not remove
import os as _ferret_os, pickle as _ferret_pickle, atexit as _ferret_atexit
import requests as _ferret_requests
import urllib3 as _ferret_urllib3
_ferret_urllib3.disable_warnings(_ferret_urllib3.exceptions.InsecureRequestWarning)
_FERRET_SESSION_FILE = "/tmp/ferret_session_{safe_session_id}.pkl"
if _ferret_os.path.exists(_FERRET_SESSION_FILE):
    try:
        with open(_FERRET_SESSION_FILE, "rb") as _f:
            session = _ferret_pickle.load(_f)
    except Exception:
        session = _ferret_requests.Session()
        session.verify = False
else:
    session = _ferret_requests.Session()
    session.verify = False
def _ferret_save_session():
    try:
        with open(_FERRET_SESSION_FILE, "wb") as _f:
            _ferret_pickle.dump(session, _f)
    except Exception:
        pass
_ferret_atexit.register(_ferret_save_session)
# [FERRET] End preamble — your script follows
"""


async def _stream_run_script(fn_args: Dict[str, Any], project_id: str = "temp", session_id: str = ""):
    """Async generator: stream run_script output line-by-line, then yield final result."""
    import asyncio as _asyncio
    import tempfile as _tempfile
    import os as _os
    import json as _json
    import time as _time

    interpreter = fn_args.get("interpreter", "bash")
    if interpreter not in ("bash", "python3"):
        yield ("[FERRET] interpreter must be 'bash' or 'python3'.", True, "[FERRET] interpreter must be 'bash' or 'python3'.")
        return
    script = fn_args.get("script", "").strip()
    if not script:
        yield ("[FERRET] script is required.", True, "[FERRET] script is required.")
        return
    timeout_sec = min(int(fn_args.get("timeout") or 30), 120)
    ext = ".sh" if interpreter == "bash" else ".py"

    # For Python scripts running inside a session context, prepend the persistent
    # session preamble so that cookies/auth survive across multiple run_script calls.
    if interpreter == "python3" and session_id:
        import re as _re
        # Sanitise session_id to a safe filename component (alphanumeric + hyphen only)
        safe_sid = _re.sub(r"[^a-zA-Z0-9\-]", "_", session_id)[:64]
        preamble = _PYTHON_SESSION_PREAMBLE_TEMPLATE.format(safe_session_id=safe_sid)
        # Strip any existing `session = requests.Session()` lines the model wrote
        # so the preamble's persistent session is not immediately overwritten.
        script = _re.sub(
            r"^\s*session\s*=\s*requests\.Session\(\).*$",
            "# [FERRET] session replaced by persistent preamble session",
            script,
            flags=_re.MULTILINE,
        )
        script = preamble + script

    # Persist the script to the workspace scripts/ subdir so it appears in the
    # file tree.  Only done when called from a session context (session_id set).
    if session_id:
        import datetime as _dt
        ts_slug = _dt.datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        script_name = f"script_{ts_slug}{ext}"
        ws_script_path = deps.WORKSPACES_DIR / project_id / session_id / "scripts" / script_name
        try:
            ws_script_path.parent.mkdir(parents=True, exist_ok=True)
            ws_script_path.write_text(script, encoding="utf-8")
        except Exception:
            pass  # non-fatal — execution continues even if persist fails

    try:
        with _tempfile.NamedTemporaryFile(mode="w", suffix=ext, delete=False, encoding="utf-8") as tf:
            tf.write(script)
            tmp_path = tf.name
        container_path = f"/tmp/ferret_script_{_os.path.basename(tmp_path)}"
        cp_proc = await _asyncio.create_subprocess_exec(
            "docker", "cp", tmp_path, f"{deps.SANDBOX_CONTAINER}:{container_path}",
            stdout=_asyncio.subprocess.PIPE, stderr=_asyncio.subprocess.STDOUT,
        )
        await cp_proc.communicate()
        _os.unlink(tmp_path)
        if cp_proc.returncode != 0:
            msg = "[FERRET] Failed to copy script into sandbox."
            yield (msg, True, msg)
            return
        exec_proc = await _asyncio.create_subprocess_exec(
            "docker", "exec", deps.SANDBOX_CONTAINER,
            interpreter, container_path,
            stdout=_asyncio.subprocess.PIPE,
            stderr=_asyncio.subprocess.STDOUT,
        )
        _t0 = _time.monotonic()
        all_chunks: List[str] = []
        total_bytes = 0
        MAX_BYTES = 8192
        timed_out = False
        try:
            async def _read_lines():
                nonlocal total_bytes, timed_out
                assert exec_proc.stdout is not None
                while True:
                    try:
                        line = await _asyncio.wait_for(exec_proc.stdout.readline(), timeout=timeout_sec)
                    except _asyncio.TimeoutError:
                        timed_out = True
                        exec_proc.kill()
                        break
                    if not line:
                        break
                    chunk = line.decode("utf-8", errors="replace")
                    total_bytes += len(chunk)
                    if total_bytes > MAX_BYTES:
                        all_chunks.append("\n... [truncated]")
                        exec_proc.kill()
                        break
                    all_chunks.append(chunk)
                    yield chunk
            async for chunk in _read_lines():
                yield (chunk, False, None)
        except Exception:
            pass
        await exec_proc.wait()
        rc = exec_proc.returncode
        _runtime_ms = round((_time.monotonic() - _t0) * 1000)
        _ts = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%d %H:%M")
        if timed_out:
            timeout_msg = f"\r\n[FERRET] Script timed out after {timeout_sec}s.\r\n"
            yield (timeout_msg, False, None)
            all_chunks.append(timeout_msg)
        full_output = "".join(all_chunks)
        prefix = f"[exit {rc}]\r\n" if rc not in (0, None) else ""
        text = prefix + full_output if full_output.strip() else f"[exit {rc}] (no output)"
        final = text + "\n__META__:" + _json.dumps({"exit_code": rc, "runtime_ms": _runtime_ms, "timestamp": _ts})
        yield ("", True, final)
    except Exception as exc:
        msg = f"[FERRET] run_script error: {exc}"
        yield (msg, True, msg)


async def _stream_run_ffuf(fn_args: Dict[str, Any]):
    """Async generator: stream run_ffuf output line-by-line, then yield final result."""
    import asyncio as _asyncio
    import shlex as _shlex
    import json as _json
    import time as _time

    url = fn_args.get("url", "").strip()
    if not url:
        msg = "[FERRET] url is required."
        yield (msg, True, msg); return
    if "FUZZ" not in url and not fn_args.get("data", "") and not fn_args.get("extra_args", ""):
        msg = "[FERRET] url must contain the FUZZ keyword (or supply data/extra_args with FUZZ)."
        yield (msg, True, msg); return
    wordlist = fn_args.get("wordlist", "/usr/share/dirb/wordlists/common.txt").strip()
    method = fn_args.get("method", "GET").upper()
    headers: Dict[str, Any] = dict(fn_args.get("headers") or {})
    data = fn_args.get("data", "").strip()
    match_codes = fn_args.get("match_codes", "200,204,301,302,307,401,403,405,500").strip()
    filter_codes = fn_args.get("filter_codes", "").strip()
    filter_size = fn_args.get("filter_size", "").strip()
    threads = min(int(fn_args.get("threads") or 40), 100)
    timeout_sec = min(int(fn_args.get("timeout") or 60), 300)
    extra_args = fn_args.get("extra_args", "").strip()

    cmd: List[str] = [
        "ffuf", "-u", url, "-w", wordlist, "-X", method,
        "-t", str(threads), "-mc", match_codes, "-timeout", "10",
        "-noninteractive",
    ]
    if filter_codes: cmd += ["-fc", filter_codes]
    if filter_size: cmd += ["-fs", filter_size]
    if data: cmd += ["-d", data]
    for hk, hv in headers.items(): cmd += ["-H", f"{hk}: {hv}"]
    if extra_args:
        try: cmd += _shlex.split(extra_args)
        except ValueError: pass

    try:
        exec_proc = await _asyncio.create_subprocess_exec(
            "docker", "exec", deps.SANDBOX_CONTAINER, *cmd,
            stdout=_asyncio.subprocess.PIPE,
            stderr=_asyncio.subprocess.STDOUT,
        )
        _t0 = _time.monotonic()
        all_chunks: List[str] = []
        total_bytes = 0
        MAX_BYTES = 16384
        timed_out = False
        try:
            async def _read_lines():
                nonlocal total_bytes, timed_out
                assert exec_proc.stdout is not None
                while True:
                    try:
                        line = await _asyncio.wait_for(exec_proc.stdout.readline(), timeout=timeout_sec)
                    except _asyncio.TimeoutError:
                        timed_out = True
                        exec_proc.kill()
                        break
                    if not line:
                        break
                    chunk = line.decode("utf-8", errors="replace")
                    total_bytes += len(chunk)
                    if total_bytes > MAX_BYTES:
                        all_chunks.append("\r\n... [truncated]\r\n")
                        exec_proc.kill()
                        break
                    # Filter ffuf progress lines — they're carriage-return noise in the UI
                    if chunk.startswith(":: Progress:") or (":: Job [" in chunk and ":: Duration:" in chunk):
                        all_chunks.append(chunk)
                        continue
                    all_chunks.append(chunk)
                    yield chunk
            async for chunk in _read_lines():
                yield (chunk, False, None)
        except Exception:
            pass
        await exec_proc.wait()
        rc = exec_proc.returncode
        _runtime_ms = round((_time.monotonic() - _t0) * 1000)
        _ts = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%d %H:%M")
        if timed_out:
            timeout_msg = f"\r\n[FERRET] ffuf timed out after {timeout_sec}s.\r\n"
            yield (timeout_msg, False, None)
            all_chunks.append(timeout_msg)
        full_output = "".join(all_chunks)
        prefix = f"[exit {rc}]\r\n" if rc not in (0, None) else ""
        text = prefix + full_output if full_output.strip() else f"[exit {rc}] (no output — no matches found)"
        final = text + "\n__META__:" + _json.dumps({"exit_code": rc, "runtime_ms": _runtime_ms, "timestamp": _ts})
        yield ("", True, final)
    except Exception as exc:
        msg = f"[FERRET] run_ffuf error: {exc}"
        yield (msg, True, msg)


async def _stream_run_katana(fn_args: Dict[str, Any]):
    """Async generator: stream katana web-crawler output line-by-line, then yield final result."""
    import asyncio as _asyncio
    import shlex as _shlex
    import json as _json
    import time as _time

    url = fn_args.get("url", "").strip()
    if not url:
        msg = "[FERRET] url is required."
        yield (msg, True, msg); return

    depth = min(int(fn_args.get("depth") or 3), 10)
    js_crawl = fn_args.get("js_crawl", True)
    headless = fn_args.get("headless", False)
    scope = fn_args.get("scope", "").strip()
    proxy = fn_args.get("proxy", "http://api:1337").strip()
    timeout_sec = min(int(fn_args.get("timeout") or 60), 300)
    extra_args = fn_args.get("extra_args", "").strip()

    cmd: List[str] = [
        "katana",
        "-u", url,
        "-depth", str(depth),
        "-silent",
        "-no-color",
    ]
    if js_crawl:
        cmd.append("-js-crawl")
    if headless:
        cmd.append("-headless")
    if scope:
        cmd += ["-field-scope", scope]
    if proxy:
        cmd += ["-proxy", proxy]
    if extra_args:
        try:
            cmd += _shlex.split(extra_args)
        except ValueError:
            pass

    try:
        exec_proc = await _asyncio.create_subprocess_exec(
            "docker", "exec", deps.SANDBOX_CONTAINER, *cmd,
            stdout=_asyncio.subprocess.PIPE,
            stderr=_asyncio.subprocess.STDOUT,
        )
        _t0 = _time.monotonic()
        all_chunks: List[str] = []
        total_bytes = 0
        MAX_BYTES = 16384
        timed_out = False
        try:
            async def _read_lines():
                nonlocal total_bytes, timed_out
                assert exec_proc.stdout is not None
                while True:
                    try:
                        line = await _asyncio.wait_for(exec_proc.stdout.readline(), timeout=timeout_sec)
                    except _asyncio.TimeoutError:
                        timed_out = True
                        exec_proc.kill()
                        break
                    if not line:
                        break
                    chunk = line.decode("utf-8", errors="replace")
                    total_bytes += len(chunk)
                    if total_bytes > MAX_BYTES:
                        all_chunks.append("\r\n... [truncated]\r\n")
                        exec_proc.kill()
                        break
                    all_chunks.append(chunk)
                    yield chunk
            async for chunk in _read_lines():
                yield (chunk, False, None)
        except Exception:
            pass
        await exec_proc.wait()
        rc = exec_proc.returncode
        _runtime_ms = round((_time.monotonic() - _t0) * 1000)
        _ts = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%d %H:%M")
        if timed_out:
            timeout_msg = f"\r\n[FERRET] katana timed out after {timeout_sec}s.\r\n"
            yield (timeout_msg, False, None)
            all_chunks.append(timeout_msg)
        full_output = "".join(all_chunks)
        prefix = f"[exit {rc}]\r\n" if rc not in (0, None) else ""
        text = prefix + full_output if full_output.strip() else f"[exit {rc}] (no output — no URLs discovered)"
        final = text + "\n__META__:" + _json.dumps({"exit_code": rc, "runtime_ms": _runtime_ms, "timestamp": _ts})
        yield ("", True, final)
    except Exception as exc:
        msg = f"[FERRET] run_katana error: {exc}"
        yield (msg, True, msg)


async def _execute_tool_call(
    tc: Dict[str, Any],
    project_id: str = "temp",
    session_id: str = "",
    recent_tool_outputs: Optional[List[str]] = None,
) -> str:
    """Execute a single tool call and return the result string.

    ``recent_tool_outputs`` is an optional list of tool result strings from the
    current agentic loop iteration.  It is used by the ``create_finding`` handler
    to detect evidence that was not actually produced by any tool in this session
    (i.e. hallucinated evidence).
    """
    fn_name = tc["function"]["name"]
    try:
        fn_args = json.loads(tc["function"].get("arguments", "{}"))
    except json.JSONDecodeError:
        fn_args = {}

    if fn_name in ("write_pytest_file", "write_test"):
        filename = fn_args.get("filename", "test_generated.py")
        code = deps.strip_fences(fn_args.get("code", ""))
        # Sanitise filename — no path traversal
        filename = filename.replace("/", "_").replace("..", "_")
        if not filename.endswith(".py"):
            filename += ".py"
        # Write into the workspace tests/ subdir when called from a session so
        # the file appears in the workspace file tree immediately.  Fall back to
        # the legacy TESTS_DIR for non-workspace callers (backwards compat).
        if session_id:
            test_path = deps.WORKSPACES_DIR / project_id / session_id / "tests" / filename
        else:
            test_path = deps.TESTS_DIR / filename
        try:
            test_path.parent.mkdir(parents=True, exist_ok=True)
            test_path.write_text(code, encoding="utf-8")
            result = await deps.run_pytest(test_path)
        except Exception as exc:
            result = f"[FERRET] Error writing/running test ({type(exc).__name__}): {exc}\n  test_path={test_path}"
        return result

    elif fn_name in ("run_pytest_file", "run_test"):
        filename = fn_args.get("filename", "")
        filename = filename.replace("/", "_").replace("..", "_")
        if not filename.endswith(".py"):
            filename += ".py"
        # Prefer workspace path when session context is available
        if session_id:
            test_path = deps.WORKSPACES_DIR / project_id / session_id / "tests" / filename
        else:
            test_path = deps.TESTS_DIR / filename
        if test_path.exists():
            return await deps.run_pytest(test_path)
        return f"[FERRET] Test file '{filename}' not found. Use write_test first."

    elif fn_name in ("read_pytest_file", "read_test"):
        filename = fn_args.get("filename", "")
        filename = filename.replace("/", "_").replace("..", "_")
        if not filename.endswith(".py"):
            filename += ".py"
        # Prefer workspace path when session context is available
        if session_id:
            test_path = deps.WORKSPACES_DIR / project_id / session_id / "tests" / filename
        else:
            test_path = deps.TESTS_DIR / filename
        if test_path.exists():
            return test_path.read_text(encoding="utf-8")
        return f"[FERRET] Test file '{filename}' not found. Use write_test to create it first."

    elif fn_name == "pip_install":
        import re as _re
        import asyncio as _asyncio
        packages = fn_args.get("packages", [])
        if not packages:
            return "[FERRET] No packages specified."
        safe_packages = [p for p in packages if _re.match(r'^[a-zA-Z0-9_\-\[\]>=<.,]+$', p)]
        if not safe_packages:
            return "[FERRET] No valid package names provided."
        try:
            proc = await _asyncio.create_subprocess_exec(
                "docker", "exec", deps.SANDBOX_CONTAINER,
                "pip3", "install", "--quiet", "--break-system-packages", *safe_packages,
                stdout=_asyncio.subprocess.PIPE,
                stderr=_asyncio.subprocess.STDOUT,
            )
            stdout, _ = await proc.communicate()
            output = stdout.decode("utf-8", errors="replace").strip()
            if proc.returncode == 0:
                return f"[FERRET] Installed: {', '.join(safe_packages)}\n{output}"
            return f"[FERRET] pip install failed (exit {proc.returncode}):\n{output}"
        except Exception as exc:
            return f"[FERRET] pip install error: {exc}"

    elif fn_name == "search_requests":
        query = fn_args.get("query", "").strip()
        limit = int(fn_args.get("limit", 20))
        try:
            # Pass the query through unchanged — the DB layer (_search_uses_like)
            # detects dots, slashes, colons and other FTS5-hostile characters and
            # routes them through LIKE on url/host/path instead of FTS5 MATCH.
            use_search = query if query else None

            # search_requests returns List[HttpRequest], not a tuple
            results = await deps.db_client.search_requests(
                search=use_search, limit=limit, project_id=project_id
            )
            if not results:
                return f"[FERRET] No requests found matching '{query}'."
            lines = []
            for r in results:
                lines.append(f"  {r.id}  {r.method} {r.url} [{r.status_code}]")
            text = "\n".join(lines)
            import json as _json
            structured = [
                {
                    "id": str(r.id),
                    "method": str(r.method).replace("HttpMethod.", ""),
                    "url": r.url,
                    "host": r.host,
                    "path": r.path,
                    "status_code": r.status_code,
                    "response_time": r.response_time,
                    "response_size": len(r.response_body.encode("utf-8")) if r.response_body else None,
                }
                for r in results
            ]
            return text + "\n__JSON__:" + _json.dumps(structured)
        except Exception as exc:
            return f"[FERRET] Search error: {exc}"

    elif fn_name == "get_request_detail":
        request_id = fn_args.get("request_id", "").strip()
        if not request_id:
            return "[FERRET] request_id is required."
        try:
            req = await deps.db_client.get_request(request_id)
            if req is None:
                return f"[FERRET] Request '{request_id}' not found."
            parts = [
                f"ID: {req.id}",
                f"Method: {req.method}  URL: {req.url}",
                f"Status: {req.status_code}",
                f"Host: {req.host}",
            ]
            if req.headers:
                parts.append("Request Headers:\n" + "\n".join(f"  {k}: {v}" for k, v in req.headers.items()))
            if req.body:
                parts.append(f"Request Body:\n{req.body[:2000]}")
            if req.response_headers:
                parts.append("Response Headers:\n" + "\n".join(f"  {k}: {v}" for k, v in req.response_headers.items()))
            if req.response_body:
                parts.append(f"Response Body:\n{req.response_body[:3000]}")
            text = "\n\n".join(parts)
            import json as _json
            structured = {
                "id": str(req.id),
                "method": str(req.method).replace("HttpMethod.", ""),
                "url": req.url,
                "host": req.host,
                "status_code": req.status_code,
                "headers": dict(req.headers) if req.headers else {},
                "body": req.body,
                "response_headers": dict(req.response_headers) if req.response_headers else {},
                "response_body": req.response_body,
            }
            return text + "\n__JSON__:" + _json.dumps(structured)
        except Exception as exc:
            return f"[FERRET] Error fetching request: {exc}"

    elif fn_name == "create_finding":
        from models import Finding

        # ── Evidence hallucination guard ────────────────────────────────────
        # Check whether the evidence field contains phrases that look like
        # confirmed outcomes (e.g. "Lab Solved!", "Checkout status: 302") but
        # were NOT actually present in any tool output from this session.
        # If suspicious phrases are found, log a warning and annotate the
        # finding so reviewers know the evidence may be fabricated.
        evidence = fn_args.get("evidence") or ""
        _SUSPICIOUS_OUTCOME_PHRASES = [
            "Lab Solved",
            "Congratulations",
            "Checkout status: 302",
            "Purchase confirmed",
            "Successfully purchased",
            "successfully solving the lab",
        ]
        _tool_outputs = recent_tool_outputs or []
        _hallucinated_phrases = [
            phrase for phrase in _SUSPICIOUS_OUTCOME_PHRASES
            if phrase.lower() in evidence.lower()
            and not any(phrase.lower() in out.lower() for out in _tool_outputs)
        ]
        if _hallucinated_phrases:
            _log.warning(
                "[chat] create_finding: evidence contains outcome phrase(s) %s "
                "not found in any tool output — possible hallucination. "
                "session_id=%s title=%r",
                _hallucinated_phrases,
                session_id,
                fn_args.get("title", ""),
            )
            evidence = (
                evidence
                + "\n\n[FERRET WARNING] The following phrase(s) in this evidence "
                "were NOT confirmed by any tool output in this session and may be "
                f"hallucinated: {_hallucinated_phrases}"
            )
            fn_args = {**fn_args, "evidence": evidence}
        # ── End evidence guard ───────────────────────────────────────────────

        try:
            finding = Finding(
                id=str(uuid.uuid4()),
                title=fn_args.get("title", "Untitled Finding"),
                severity=fn_args.get("severity", "info"),
                type=fn_args.get("type", "other"),
                host=fn_args.get("host", ""),
                description=fn_args.get("description"),
                evidence=fn_args.get("evidence"),
                request_id=fn_args.get("request_id"),
                source="ai",
                status="open",
                created_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
            await deps.db_client.store_finding(finding, project_id=project_id)
            parts = [
                f"[FERRET] Finding created: id={finding.id}",
                f"  Title: {finding.title}",
                f"  Severity: {finding.severity}",
                f"  Host: {finding.host}",
            ]
            if finding.description:
                parts.append(f"  Description: {finding.description}")
            if finding.evidence:
                parts.append(f"  Evidence: {finding.evidence}")
            return "\n".join(parts)
        except Exception as exc:
            return f"[FERRET] Error creating finding: {exc}"

    elif fn_name == "list_findings":
        try:
            severity = fn_args.get("severity")
            status = fn_args.get("status")
            findings = await deps.db_client.get_findings(
                severity=severity, status=status, project_id=project_id
            )
            if not findings:
                return "[FERRET] No findings found for this project."
            lines = []
            for f in findings:
                lines.append(
                    f"  [{f.get('severity','?').upper()}] {f.get('title','?')} "
                    f"(id={f.get('id','?')}, status={f.get('status','?')}, host={f.get('host','?')})"
                )
            return "\n".join(lines)
        except Exception as exc:
            return f"[FERRET] Error listing findings: {exc}"

    elif fn_name == "run_script":
        # Delegate to the streaming generator; collect all output for non-streaming callers
        chunks: List[str] = []
        final: str = ""
        async for _chunk, _is_final, _result in _stream_run_script(fn_args, project_id=project_id, session_id=session_id):
            if _is_final:
                final = _result or ""
            else:
                chunks.append(_chunk)
        return final if final else "".join(chunks)

    elif fn_name == "run_katana":
        # Delegate to the streaming generator; collect all output for non-streaming callers
        chunks: List[str] = []
        final: str = ""
        async for _chunk, _is_final, _result in _stream_run_katana(fn_args):
            if _is_final:
                final = _result or ""
            else:
                chunks.append(_chunk)
        return final if final else "".join(chunks)

    elif fn_name == "run_ffuf":
        # Delegate to the streaming generator; collect all output for non-streaming callers
        chunks: List[str] = []
        final: str = ""
        async for _chunk, _is_final, _result in _stream_run_ffuf(fn_args):
            if _is_final:
                final = _result or ""
            else:
                chunks.append(_chunk)
        return final if final else "".join(chunks)

    elif fn_name == "http_request":
        method = fn_args.get("method", "GET").upper()
        url = fn_args.get("url", "").strip()
        if not url:
            return "[FERRET] url is required."
        req_headers: Dict[str, Any] = dict(fn_args.get("headers") or {})
        body = fn_args.get("body") or None
        content_type = fn_args.get("content_type")
        via_proxy = fn_args.get("via_proxy", True)
        timeout = int(fn_args.get("timeout") or 15)

        if content_type:
            req_headers["Content-Type"] = content_type

        proxy_url = "http://127.0.0.1:1337" if via_proxy else None
        proxies = {"http://": proxy_url, "https://": proxy_url} if proxy_url else {}

        try:
            async with httpx.AsyncClient(
                verify=False,
                proxies=proxies,
                timeout=float(timeout),
                follow_redirects=True,
            ) as client:
                resp = await client.request(
                    method,
                    url,
                    headers=req_headers,
                    content=body.encode() if body else None,
                )

            body_text = resp.text
            body_preview = body_text[:3000]
            if len(body_text) > 3000:
                body_preview += f"\n... ({len(body_text) - 3000} bytes truncated)"

            elapsed_ms = int(resp.elapsed.total_seconds() * 1000) if resp.elapsed else 0

            import json as _json
            return _json.dumps({
                "status_code": resp.status_code,
                "elapsed_ms": elapsed_ms,
                "response_headers": dict(resp.headers),
                "response_body": body_preview,
            })
        except httpx.TimeoutException:
            return f"[FERRET] Request timed out after {timeout}s — possible blind injection if intentional."
        except Exception as exc:
            return f"[FERRET] HTTP request failed: {exc}"

    return f"[FERRET] Unknown tool: {fn_name}"


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
                _ai_cfg_with_key, model, or_messages + new_messages, _SESSION_CHAT_TOOLS
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

            import time as _time
            # Collect tool outputs already accumulated in this iteration so that
            # create_finding can validate evidence against them.
            _recent_outputs = [
                m.get("content", "") for m in new_messages if m.get("role") == "tool"
            ]
            for tc in tool_calls:
                _t0 = _time.monotonic()
                tool_result = await _execute_tool_call(
                    tc,
                    project_id=project_id,
                    session_id=session_id,
                    recent_tool_outputs=_recent_outputs,
                )
                _runtime_ms = round((_time.monotonic() - _t0) * 1000)
                _ts = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%d %H:%M")
                _meta_prefix = "\n__META__:"
                _meta_idx = tool_result.rfind(_meta_prefix)
                if _meta_idx != -1:
                    try:
                        _existing_meta = json.loads(tool_result[_meta_idx + len(_meta_prefix):])
                    except Exception:
                        _existing_meta = {}
                    _existing_meta["runtime_ms"] = _runtime_ms
                    _existing_meta["timestamp"] = _ts
                    tool_result = tool_result[:_meta_idx] + _meta_prefix + json.dumps(_existing_meta)
                else:
                    tool_result = tool_result + _meta_prefix + json.dumps({"runtime_ms": _runtime_ms, "timestamp": _ts})
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

        new_messages: List[Dict[str, Any]] = []
        max_iterations = max(1, min(50, body.max_tool_calls or 10))

        for iteration in range(max_iterations):
            # Stream the completion (OpenAI-compat SSE) or fall back to non-streaming (Anthropic)
            accumulated_content = ""
            accumulated_tool_calls: Dict[int, Dict] = {}

            _url, _headers, _body = _build_ai_request(
                _ai_cfg_with_key, model, or_messages + new_messages, _SESSION_CHAT_TOOLS
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

            # Execute tool calls — run_script/run_katana/run_ffuf stream chunks; others execute atomically
            for tc in tool_calls_list:
                fn_name = tc["function"]["name"]
                try:
                    fn_args_raw = json.loads(tc["function"].get("arguments", "{}"))
                except json.JSONDecodeError:
                    fn_args_raw = {}
                yield f"data: {json.dumps({'type': 'tool_start', 'name': fn_name, 'args': tc['function'].get('arguments', '{}')})}\n\n"

                if fn_name == "run_script":
                    _streamer = _stream_run_script(fn_args_raw, project_id=project_id, session_id=session_id)
                elif fn_name == "run_katana":
                    _streamer = _stream_run_katana(fn_args_raw)
                elif fn_name == "run_ffuf":
                    _streamer = _stream_run_ffuf(fn_args_raw)
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
                    import time as _time
                    _t0 = _time.monotonic()
                    # Collect tool outputs already accumulated in this iteration
                    # so that create_finding can validate evidence against them.
                    _recent_outputs = [
                        m.get("content", "") for m in new_messages if m.get("role") == "tool"
                    ]
                    tool_result = await _execute_tool_call(
                        tc,
                        project_id=project_id,
                        session_id=session_id,
                        recent_tool_outputs=_recent_outputs,
                    )
                    _runtime_ms = round((_time.monotonic() - _t0) * 1000)
                    _ts = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%d %H:%M")
                    _meta_prefix = "\n__META__:"
                    _meta_idx = tool_result.rfind(_meta_prefix)
                    if _meta_idx != -1:
                        try:
                            _existing_meta = json.loads(tool_result[_meta_idx + len(_meta_prefix):])
                        except Exception:
                            _existing_meta = {}
                        _existing_meta["runtime_ms"] = _runtime_ms
                        _existing_meta["timestamp"] = _ts
                        tool_result = tool_result[:_meta_idx] + _meta_prefix + json.dumps(_existing_meta)
                    else:
                        tool_result = tool_result + _meta_prefix + json.dumps({"runtime_ms": _runtime_ms, "timestamp": _ts})

                yield f"data: {json.dumps({'type': 'tool_result', 'name': fn_name, 'content': tool_result})}\n\n"
                new_messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "name": fn_name,
                    "content": tool_result,
                })

        # Persist all new messages
        await deps.db_client.append_chat_message(session_id, {"role": "user", "content": body.message})
        for msg in new_messages:
            await deps.db_client.append_chat_message(session_id, msg)

        updated = await deps.db_client.get_chat_history(session_id)
        yield f"data: {json.dumps({'type': 'done', 'messages': updated})}\n\n"

    return StreamingResponse(_generate(), media_type="text/event-stream")

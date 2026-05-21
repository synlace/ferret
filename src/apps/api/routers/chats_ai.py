"""
Provider-aware AI call helpers and system prompt builder.
"""

import json
import logging
import re
from typing import List, Dict, Any, Optional, Tuple

import httpx
from fastapi import HTTPException

import deps

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Thinking-block extraction (shared with chats.py and chats_crud.py)
# ---------------------------------------------------------------------------

_THINKING_RE = re.compile(r"<\|channel>thought\n(.*?)\n<channel\|>", re.DOTALL)
_TOOL_CODE_RE = re.compile(r"<tool_code>.*?</tool_code>", re.DOTALL)


def _extract_thinking(content: str) -> Tuple[str, Optional[str]]:
    """Return (clean_content, thinking_text_or_None).

    Extracts <|channel>thought...<channel|> blocks into a separate string and
    strips <tool_code> blocks (Ferret handles tool execution natively).
    """
    thinking_parts = _THINKING_RE.findall(content)
    thinking: Optional[str] = "\n\n".join(thinking_parts) if thinking_parts else None
    clean = _THINKING_RE.sub("", content)
    clean = _TOOL_CODE_RE.sub("", clean).strip()
    return clean, thinking


def clean_messages_for_display(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Retroactively clean assistant messages that still have raw thinking/tool_code tags.

    Applied when reading history from the DB so old messages stored before the
    extraction was added are cleaned on-the-fly without modifying the DB.
    """
    cleaned: List[Dict[str, Any]] = []
    for msg in messages:
        if msg.get("role") == "assistant" and msg.get("content") and not msg.get("thinking"):
            raw_content = msg["content"]
            clean_content, thinking = _extract_thinking(raw_content)
            if thinking or clean_content != raw_content:
                msg = {**msg, "content": clean_content}
                if thinking:
                    msg["thinking"] = thinking
        cleaned.append(msg)
    return cleaned


_NO_KEY_NOTICE = (
    "**No API key configured for this project.**\n\n"
    "Go to **Projects → Keys → Create Key** to provision one, "
    "then come back and send your message."
)


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
            # Strip the human-facing `label` key — it is not part of the OpenAI schema
            # and some providers reject unknown fields.
            def _strip_label(t: dict) -> dict:
                fn = {k: v for k, v in t["function"].items() if k != "label"}
                return {**t, "function": fn}
            body["tools"] = [_strip_label(t) for t in tools]
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


_LOCAL_PROVIDERS = frozenset({"ollama", "lmstudio"})


async def _resolve_project_and_key(session_id: str, fallback_project_id: str):
    """Return (project_id, api_key, ai_config, project_row) for a session.

    Key resolution order (see deps.get_key_for_project):
    1. Provisioned per-project sub-key (OpenRouter provisioning flow).
    2. Global API key saved by the setup wizard.
    3. Raises 503 if neither is available — unless the provider is local
       (ollama / lmstudio), which requires no API key.

    The returned ``ai_config`` dict contains the active provider, base_url,
    format, and model so callers can route to the correct endpoint.
    """
    _session = await deps.db_client.get_chat_session(session_id)
    project_id = ((_session.get("project_id") if _session else None) or fallback_project_id)
    _log.info("[chat] session=%s resolved project_id=%s", session_id, project_id)

    ai_cfg = deps.get_ai_config()
    provider = ai_cfg.get("provider", "")

    api_key = await deps.get_key_for_project(project_id)
    if not api_key and provider not in _LOCAL_PROVIDERS:
        raise HTTPException(
            503,
            f"No provisioned key for project '{project_id}'. "
            "Configure a provider via Setup, or add a provisioned key via Projects → Keys."
        )

    _log.info("[chat] using key prefix=%s... for project=%s provider=%s",
              (api_key[:16] if api_key else "NONE"), project_id, provider)
    project = await deps.db_client.get_project(project_id)
    return project_id, api_key, ai_cfg, project


def _build_or_messages(
    history: List[Dict[str, Any]],
    new_user_message: str,
    tools: List[Dict[str, Any]] | None = None,
) -> List[Dict[str, Any]]:
    # Compute the set of active tool names so we can conditionally include
    # workflow steps only for tools that are actually enabled in this session.
    # tools=None means "all enabled"; tools=[] means "all disabled".
    _no_tools = tools is not None and len(tools) == 0
    _active = {t["function"]["name"] for t in (tools or [])}

    # ---------------------------------------------------------------------------
    # Static sections (always included)
    # ---------------------------------------------------------------------------
    system_prompt = (
        "You are a security testing assistant in FERRET (a MITM proxy tool). "
        "Be concise. Use Markdown: code blocks for code, bullets for findings.\n\n"

        "Grounding rules (CRITICAL — read before every response):\n"
        "0. NEVER claim success, failure, or any outcome unless the tool output explicitly "
        "confirms it. If a script prints 'Lab not solved yet', the lab is NOT solved — "
        "do not write a summary claiming it is.\n"
        "1. After every tool call, read the ACTUAL output before deciding what to do next. "
        "Do not assume the outcome.\n"
        "2. HTTP 200 from a checkout or action endpoint means the page rendered — it does "
        "NOT mean the action succeeded. Only a 302 redirect or an explicit success string "
        "in the response body confirms success.\n"
        "3. The evidence field in create_finding MUST be copied verbatim from tool output. "
        "Never write evidence that was not returned by a tool in this session.\n"
        "4. If a verification script returns a negative result (e.g. 'not solved', "
        "'Insufficient funds', 'error'), acknowledge the failure and retry with a "
        "corrected approach. Do not repeat the same claim.\n\n"

        "Tool call rules:\n"
        "0. Always set the 'rationale' field to one sentence explaining why you are calling the tool.\n"
        "1. Only call tools that are available to you in this session. "
        "Do not reference or attempt to call tools that are not listed in your tool schemas.\n\n"
    )

    # ---------------------------------------------------------------------------
    # No-tools notice — injected when the user has disabled all tools
    # ---------------------------------------------------------------------------
    if _no_tools:
        system_prompt += (
            "IMPORTANT: You have NO tools available in this session. "
            "All tools have been disabled by the user. "
            "You must not reference, describe, or attempt to call any tools. "
            "Respond only with plain text based on the conversation history.\n\n"
        )

    # ---------------------------------------------------------------------------
    # Partial-tools notice — injected when only a subset of tools is enabled.
    # Without this, the LLM answers "which tools do you have?" from its training
    # knowledge and lists all tools it knows about, not just the enabled ones.
    # ---------------------------------------------------------------------------
    elif tools is not None:
        # tools is a non-empty subset — compare against the full catalog size
        from chats_tools import SESSION_CHAT_TOOLS as _ALL_TOOLS
        if len(tools) < len(_ALL_TOOLS):
            _enabled_names = ", ".join(f"`{t['function']['name']}`" for t in tools)
            system_prompt += (
                f"IMPORTANT: In this session you ONLY have access to the following tool(s): {_enabled_names}. "
                "You must not mention, describe, or suggest using any other tools — even if you know they exist. "
                "If asked which tools you have, list ONLY the tools named above.\n\n"
            )

    # ---------------------------------------------------------------------------
    # run_script session rules — only if run_script is enabled
    # ---------------------------------------------------------------------------
    if "run_script" in _active:
        system_prompt += (
            "run_script session rules:\n"
            "Each run_script call runs in a FRESH Python process — requests.Session() objects "
            "do NOT persist between calls. To maintain cookies/auth across multiple scripts, "
            "use the injected `session` variable (automatically persisted to disk between calls "
            "within this chat session). Do NOT create a new `session = requests.Session()` — "
            "the persistent session is already available as `session`.\n\n"
        )

    # ---------------------------------------------------------------------------
    # Workflow order — only include steps for enabled tools
    # ---------------------------------------------------------------------------
    workflow_steps = []
    step = 1
    if "list_sources" in _active:
        workflow_steps.append(
            f"{step}. Call list_sources to check whether API documentation, source code, or other "
            "reference material has been attached to this project. If sources exist, call "
            "read_source to load the relevant ones before analysing traffic — they provide "
            "ground truth about the target."
        )
        step += 1
    if "search_requests" in _active:
        workflow_steps.append(
            f"{step}. ALWAYS call search_requests to understand what traffic has already been "
            "captured by the proxy. The target host and scope come from this data — never "
            "assume or guess a target."
        )
        step += 1
    if "run_katana" in _active:
        workflow_steps.append(
            f"{step}. Only use run_katana if search_requests returns insufficient endpoint "
            "coverage (e.g. you need to find paths not yet visited). Never run katana against "
            "a host that was not first confirmed in search_requests results."
        )
        step += 1
    if "run_ffuf" in _active:
        workflow_steps.append(
            f"{step}. Only use run_ffuf for parameter fuzzing, credential brute-forcing, or "
            "SQLi — never for directory/file discovery."
        )
        step += 1

    if workflow_steps:
        system_prompt += "Workflow order (MANDATORY — follow this sequence every time):\n"
        system_prompt += "\n".join(workflow_steps) + "\n\n"

    # ---------------------------------------------------------------------------
    # pytest rules — only if write_pytest_file or run_pytest_file are enabled
    # ---------------------------------------------------------------------------
    _pytest_tools = {"write_pytest_file", "run_pytest_file", "run_test"}
    if _active & _pytest_tools:
        system_prompt += (
            "pytest rules:\n"
            "1. Always add `verify=False` to every request and "
            "`import urllib3; urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)` at the top.\n"
            "2. Proxy address: `proxies={'https': 'http://api:1337', 'http': 'http://api:1337'}`. "
            "Never use 127.0.0.1 or localhost.\n"
        )
        if "pip_install" in _active:
            system_prompt += (
                "3. ModuleNotFoundError → pip_install, then re-run the SAME file. "
                "Never create _v2/_v3 variants.\n"
            )
        system_prompt += (
            "4. Other failures → read the file, fix in place, overwrite with the SAME filename.\n"
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

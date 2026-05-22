"""
Provider-aware AI call helpers and system prompt builder.
"""

import json
import logging
import re
import uuid
from typing import List, Dict, Any, Optional, Tuple

import httpx
from fastapi import HTTPException

import deps

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Thinking-block extraction (shared with chats.py and chats_crud.py)
# ---------------------------------------------------------------------------

_THINKING_RE = re.compile(r"<\|channel>thought\n(.*?)\n<channel\|>", re.DOTALL)
# Also handle the variant without a trailing newline before the closing tag
_THINKING_RE2 = re.compile(r"<\|channel>thought\n(.*?)<channel\|>", re.DOTALL)
_TOOL_CODE_RE = re.compile(r"<tool_code>.*?</tool_code>", re.DOTALL)

# Non-standard tool call syntax emitted by some local models:
#
#   Kimi/Moonshot (closed tag):
#     <|tool_call>call:name{key:"value",...}<tool_call|>
#
#   Gemma 4 (no closing tag, terminated by [END_TOOL_REQUEST] or end-of-string):
#     <|tool_call>call:name{key:<|"|>value<|"|>,...}
#     [END_TOOL_REQUEST]
#
# We parse these into proper OpenAI tool_calls dicts so the agentic loop can
# execute them normally.
#
# The regex matches either form: closed by <tool_call|>, by [END_TOOL_REQUEST],
# or by end-of-string.
_TOOL_CALL_TAG_RE = re.compile(
    r"<\|tool_call>(.*?)(?:<tool_call\|>|\[END_TOOL_REQUEST\]|$)",
    re.DOTALL,
)

# Hallucinated tool result blocks some models inject inline:
#   [TOOL_RESULT]\n...\n[END_TOOL_RESULT]
_TOOL_RESULT_BLOCK_RE = re.compile(r"\[TOOL_RESULT\].*?\[END_TOOL_RESULT\]", re.DOTALL)

# Stray [END_TOOL_REQUEST] markers left after stripping <|tool_call> blocks
_END_TOOL_REQUEST_RE = re.compile(r"\[END_TOOL_REQUEST\]", re.DOTALL)

# call:name{...} inside a <|tool_call> block
_TOOL_CALL_BODY_RE = re.compile(r"call:(\w+)\{(.*)\}", re.DOTALL)


def _parse_nonstandard_tool_calls(raw_body: str) -> Optional[Dict[str, Any]]:
    """Parse a single <|tool_call> body into an OpenAI tool_call dict.

    Handles the ``call:name{key:"value",...}`` format emitted by some local
    models.  Returns None if the body cannot be parsed.
    """
    m = _TOOL_CALL_BODY_RE.match(raw_body.strip())
    if not m:
        return None
    fn_name = m.group(1)
    args_raw = m.group(2).strip()

    # The args may use bare keys or single-quoted strings — try JSON first,
    # then fall back to a best-effort key:value extraction.
    # Normalise <|"|> quote escapes used by some models.
    args_raw = args_raw.replace("<|\"|>", '"')
    try:
        args_dict = json.loads("{" + args_raw + "}")
    except json.JSONDecodeError:
        # Best-effort: extract key:"value" pairs
        pairs = re.findall(r'(\w+)\s*:\s*"((?:[^"\\]|\\.)*)"', args_raw)
        args_dict = {k: v for k, v in pairs} if pairs else {}

    return {
        "id": str(uuid.uuid4())[:8],
        "type": "function",
        "function": {
            "name": fn_name,
            "arguments": json.dumps(args_dict),
        },
    }


def _extract_thinking(content: str) -> Tuple[str, Optional[str]]:
    """Return (clean_content, thinking_text_or_None).

    Extracts <|channel>thought...<channel|> blocks into a separate string and
    strips <tool_code>, hallucinated [TOOL_RESULT] blocks, and non-standard
    <|tool_call> blocks (Ferret handles tool execution natively via the OpenAI
    tool_calls schema).

    Each thinking block is separated by a horizontal rule so the UI can render
    them as distinct segments within the single collapsible ThinkingBlock.
    """
    # Try strict pattern first (newline before closing tag), then relaxed
    thinking_parts = _THINKING_RE.findall(content)
    if not thinking_parts:
        thinking_parts = _THINKING_RE2.findall(content)

    thinking: Optional[str] = "\n\n---\n\n".join(p.strip() for p in thinking_parts) if thinking_parts else None

    # Remove thinking blocks from visible content
    clean = _THINKING_RE.sub("", content)
    clean = _THINKING_RE2.sub("", clean)
    # Strip non-standard tool call tags (closed or open/Gemma-style)
    clean = _TOOL_CALL_TAG_RE.sub("", clean)
    # Strip any stray [END_TOOL_REQUEST] markers left after tag removal
    clean = _END_TOOL_REQUEST_RE.sub("", clean)
    # Strip hallucinated tool result blocks
    clean = _TOOL_RESULT_BLOCK_RE.sub("", clean)
    clean = _TOOL_CODE_RE.sub("", clean).strip()
    return clean, thinking


def extract_nonstandard_tool_calls(content: str) -> List[Dict[str, Any]]:
    """Extract <|tool_call>...<tool_call|> blocks from content and return them
    as a list of OpenAI-format tool_call dicts.

    Called by the streaming loop when the model emits tool calls as text
    instead of via the proper function-calling schema.
    """
    tool_calls = []
    for m in _TOOL_CALL_TAG_RE.finditer(content):
        tc = _parse_nonstandard_tool_calls(m.group(1))
        if tc:
            tool_calls.append(tc)
    return tool_calls


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
    # Workspace file naming rules — injected whenever any file-creating tool is active
    # ---------------------------------------------------------------------------
    _file_tools = {"run_script", "write_test", "write_pytest_file", "write_note", "write_credential"}
    if _active & _file_tools:
        system_prompt += (
            "Workspace file naming rules (CRITICAL):\n"
            "All files you create land in the workspace/ scratch area (scripts/tests are "
            "auto-promoted to scripts/ or tests/ when they exit/pass cleanly). "
            "Names must be short, descriptive, and follow these patterns:\n"
            "  Scripts (run_script name=):  <action>_<target>  "
            "e.g. exploit_sqli_login, recon_api_endpoints, brute_admin_password, probe_idor_orders\n"
            "  Tests (write_test filename=):  test_<target>_<vulnerability>.py  "
            "e.g. test_login_sqli.py, test_checkout_idor.py, test_api_auth_bypass.py\n"
            "  Notes (write_note filename=):  <topic>.md  "
            "e.g. recon_summary.md, api_endpoints.md, attack_plan.md, vuln_notes.md\n"
            "  Credentials (write_credential filename=):  <service>_<type>.txt  "
            "e.g. admin_creds.txt, api_keys.txt, jwt_tokens.txt, session_cookies.txt\n"
            "Rules:\n"
            "  - Use lowercase_snake_case only.\n"
            "  - Be specific: include the target endpoint/feature AND the attack/action.\n"
            "  - NEVER use generic names: script, test, run, poc, exploit, generated, temp, v2, v3.\n"
            "  - NEVER append _v2/_v3 to fix a broken file — read it, fix in place, reuse the same name.\n"
            "  - Always set the `name` parameter in run_script calls.\n\n"
        )

    # ---------------------------------------------------------------------------
    # write_note / write_credential guidance — only if those tools are enabled
    # ---------------------------------------------------------------------------
    if "write_note" in _active:
        system_prompt += (
            "write_note usage:\n"
            "Use write_note to record structured information about the target: recon findings, "
            "endpoint inventories, attack plans, vulnerability notes, or any reference material "
            "that will be useful later in the session. "
            "Write notes proactively — don't wait to be asked. "
            "Good triggers: after search_requests reveals interesting endpoints, after katana "
            "crawl completes, after confirming a vulnerability.\n\n"
        )
    if "write_credential" in _active:
        system_prompt += (
            "write_credential usage:\n"
            "Use write_credential immediately whenever you discover or confirm working credentials: "
            "username/password pairs, API keys, JWT tokens, session cookies, SSH keys, or any "
            "other authentication material. "
            "Always record credentials before continuing — they may be needed later in the session.\n\n"
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
            f"{step}. Call search_requests to understand what traffic has already been "
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
        system_prompt += (
            "Workflow order (ONLY follow this sequence when the user explicitly asks you "
            "to start an investigation, analyse traffic, test a target, or perform a "
            "security task. Do NOT call any tools in response to greetings (e.g. 'Hello', "
            "'Hi', 'Hey'), questions about your capabilities, or any message that does not "
            "contain a clear security testing request. For such messages, respond with "
            "plain text only):\n"
        )
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

"""
LiteLLM-backed AI call helpers — replaces the raw httpx provider layer in chats_ai.py.

Key differences from chats_ai.py:
- Uses litellm.acompletion() instead of raw httpx calls.
- Provider/format routing is handled by LiteLLM's model string prefix
  (e.g. "openrouter/anthropic/claude-3-5-sonnet", "anthropic/claude-3-5-sonnet-20241022",
  "ollama/llama3") — no manual dual-format branching required.
- Cost tracking uses LiteLLM's built-in usage metadata.
- _extract_thinking, clean_messages_for_display, _build_or_messages, and
  _resolve_project_and_key are re-exported from chats_ai so callers can
  import everything from one place.
"""

from __future__ import annotations

import logging
from typing import AsyncIterator, Dict, Any, List, Optional, Tuple

import litellm
from fastapi import HTTPException

import deps

# Re-export shared helpers so callers only need to import from chats_ai_v2
from chats_ai import (
    _extract_thinking,
    clean_messages_for_display,
    _build_or_messages,
    _resolve_project_and_key,
    _NO_KEY_NOTICE,
)

_log = logging.getLogger(__name__)

# Silence LiteLLM's verbose startup banner and per-request logs unless DEBUG.
litellm.suppress_debug_info = True
litellm.set_verbose = False
# Silently drop unsupported parameters (e.g. tool_choice for Gemini via OpenRouter)
# instead of forwarding them and getting a broken/empty response.
litellm.drop_params = True

# ---------------------------------------------------------------------------
# Provider → LiteLLM model prefix mapping
# ---------------------------------------------------------------------------

_PROVIDER_PREFIX: Dict[str, str] = {
    "openrouter": "openrouter",
    "openai":     "",           # no prefix needed — openai is the default
    "anthropic":  "anthropic",
    "gemini":     "gemini",
    "deepseek":   "deepseek",
    "mistral":    "mistral",
    "ollama":     "ollama",
    "lmstudio":   "openai",     # LM Studio exposes an OpenAI-compat endpoint
}

_LOCAL_PROVIDERS = frozenset({"ollama", "lmstudio"})


def _litellm_model(ai_cfg: dict, model: str) -> str:
    """Return the LiteLLM model string for the given provider config and model name.

    LiteLLM uses prefixed model strings to route to the correct provider:
      openrouter/anthropic/claude-3-5-sonnet
      anthropic/claude-3-5-sonnet-20241022
      ollama/llama3
    """
    provider = ai_cfg.get("provider", "openrouter")
    prefix = _PROVIDER_PREFIX.get(provider, "")
    if prefix and not model.startswith(f"{prefix}/"):
        return f"{prefix}/{model}"
    return model


def _litellm_kwargs(ai_cfg: dict, api_key: str) -> Dict[str, Any]:
    """Build the extra kwargs for litellm.acompletion() from the provider config.

    Handles:
    - api_key injection
    - api_base override (for local providers and custom endpoints)
    - OpenRouter-specific headers
    """
    provider = ai_cfg.get("provider", "openrouter")
    base_url = ai_cfg.get("base_url", "")
    kwargs: Dict[str, Any] = {}

    if api_key:
        kwargs["api_key"] = api_key

    if base_url:
        kwargs["api_base"] = base_url

    # OpenRouter requires extra headers for attribution / routing
    if provider == "openrouter":
        kwargs["extra_headers"] = {
            "HTTP-Referer": "https://github.com/synlace/ferret",
            "X-Title": "Ferret",
        }

    return kwargs


def _strip_label_from_tools(tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Remove the human-facing `label` key from tool schemas.

    The `label` field is Ferret-internal and not part of the OpenAI/Anthropic
    tool schema.  Some providers reject requests that contain unknown fields.
    """
    cleaned = []
    for t in tools:
        fn = {k: v for k, v in t["function"].items() if k != "label"}
        cleaned.append({**t, "function": fn})
    return cleaned


# ---------------------------------------------------------------------------
# Streaming completion — yields (delta_text, tool_calls_list, usage_dict)
# ---------------------------------------------------------------------------

async def stream_ai_completion(
    ai_cfg: dict,
    api_key: str,
    model: str,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
) -> AsyncIterator[Tuple[str, List[Dict[str, Any]], Optional[Dict[str, Any]]]]:
    """Async generator that streams an AI completion via LiteLLM.

    Yields tuples of:
      (text_delta: str, tool_calls: list, usage: dict | None)

    - text_delta: incremental text token (empty string if none in this chunk)
    - tool_calls: list of fully-assembled tool call dicts (only non-empty on
      the final chunk when tool calls are complete)
    - usage: LiteLLM usage dict (only non-None on the final [DONE] chunk)

    The caller is responsible for accumulating text_delta values and
    processing tool_calls when they appear.
    """
    litellm_model = _litellm_model(ai_cfg, model)
    extra_kwargs = _litellm_kwargs(ai_cfg, api_key)

    # Strip Ferret-internal `label` field from tool schemas
    clean_tools = _strip_label_from_tools(tools) if tools else None

    _log.info(
        "[chat/v2] litellm model=%s provider=%s tools=%d",
        litellm_model,
        ai_cfg.get("provider", "?"),
        len(clean_tools) if clean_tools else 0,
    )

    # Build kwargs — only pass tools/tool_choice when tools are present
    call_kwargs: Dict[str, Any] = {
        "model": litellm_model,
        "messages": messages,
        "stream": True,
        "timeout": 90.0,
        **extra_kwargs,
    }
    if clean_tools:
        call_kwargs["tools"] = clean_tools
        call_kwargs["tool_choice"] = "auto"

    try:
        response = await litellm.acompletion(**call_kwargs)
    except litellm.exceptions.AuthenticationError as e:
        raise HTTPException(503, f"AI provider authentication failed: {e}")
    except litellm.exceptions.BadRequestError as e:
        raise HTTPException(400, f"AI provider bad request: {e}")
    except litellm.exceptions.APIConnectionError as e:
        raise HTTPException(502, f"AI provider connection error: {e}")
    except litellm.exceptions.RateLimitError as e:
        raise HTTPException(429, f"AI provider rate limit: {e}")
    except Exception as e:
        raise HTTPException(502, f"AI provider error: {e}")

    # Accumulate tool call deltas across chunks
    accumulated_tool_calls: Dict[int, Dict[str, Any]] = {}
    accumulated_text = ""
    final_yielded = False
    last_usage_dict: Optional[Dict[str, Any]] = None

    async for chunk in response:
        try:
            choice = chunk.choices[0]
        except (IndexError, AttributeError):
            continue

        delta = getattr(choice, "delta", None)
        if delta is None:
            continue

        # Text delta
        text = getattr(delta, "content", None) or ""
        if text:
            accumulated_text += text

        # Tool call deltas — LiteLLM normalises these to OpenAI format
        tc_deltas = getattr(delta, "tool_calls", None) or []
        for tc_delta in tc_deltas:
            idx = getattr(tc_delta, "index", 0)
            if idx not in accumulated_tool_calls:
                accumulated_tool_calls[idx] = {
                    "id": "",
                    "type": "function",
                    "function": {"name": "", "arguments": ""},
                }
            tc = accumulated_tool_calls[idx]
            fn = getattr(tc_delta, "function", None)
            if fn:
                if getattr(fn, "name", None):
                    tc["function"]["name"] += fn.name
                if getattr(fn, "arguments", None):
                    tc["function"]["arguments"] += fn.arguments
            if getattr(tc_delta, "id", None):
                tc["id"] = tc_delta.id

        # Usage is only present on the final chunk (stream_options include_usage)
        usage = getattr(chunk, "usage", None)
        if usage:
            last_usage_dict = {
                "prompt_tokens":     getattr(usage, "prompt_tokens", 0),
                "completion_tokens": getattr(usage, "completion_tokens", 0),
                "total_tokens":      getattr(usage, "total_tokens", 0),
            }

        finish_reason = getattr(choice, "finish_reason", None)
        # Treat any non-None, non-empty finish_reason as terminal.
        # LiteLLM normalises most providers but some (e.g. OpenRouter+Gemini)
        # may use unexpected casing or values — accepting all non-None values
        # is safer than a hardcoded allowlist.
        is_terminal = bool(finish_reason)
        if is_terminal:
            # Final chunk — emit assembled tool calls and any trailing text
            tool_calls_list = list(accumulated_tool_calls.values())
            final_yielded = True
            yield text, tool_calls_list, last_usage_dict
        else:
            # Intermediate chunk — emit text delta only
            if text:
                yield text, [], None

    # Safety: if the stream ended without any finish_reason chunk, emit what we
    # accumulated so far so the caller always gets at least one yield.
    if not final_yielded:
        tool_calls_list = list(accumulated_tool_calls.values())
        yield accumulated_text, tool_calls_list, last_usage_dict


# ---------------------------------------------------------------------------
# Non-streaming completion (used as fallback / for tests)
# ---------------------------------------------------------------------------

async def complete_ai(
    ai_cfg: dict,
    api_key: str,
    model: str,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[str, List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Single-shot (non-streaming) completion via LiteLLM.

    Returns (content, tool_calls, usage_dict).
    """
    litellm_model = _litellm_model(ai_cfg, model)
    extra_kwargs = _litellm_kwargs(ai_cfg, api_key)
    clean_tools = _strip_label_from_tools(tools) if tools else None

    call_kwargs: Dict[str, Any] = {
        "model": litellm_model,
        "messages": messages,
        "timeout": 90.0,
        **extra_kwargs,
    }
    if clean_tools:
        call_kwargs["tools"] = clean_tools
        call_kwargs["tool_choice"] = "auto"

    try:
        response = await litellm.acompletion(**call_kwargs)
    except litellm.exceptions.AuthenticationError as e:
        raise HTTPException(503, f"AI provider authentication failed: {e}")
    except litellm.exceptions.BadRequestError as e:
        raise HTTPException(400, f"AI provider bad request: {e}")
    except litellm.exceptions.APIConnectionError as e:
        raise HTTPException(502, f"AI provider connection error: {e}")
    except Exception as e:
        raise HTTPException(502, f"AI provider error: {e}")

    choice = response.choices[0]
    msg = choice.message
    content: str = getattr(msg, "content", None) or ""
    raw_tool_calls = getattr(msg, "tool_calls", None) or []

    tool_calls: List[Dict[str, Any]] = []
    for tc in raw_tool_calls:
        tool_calls.append({
            "id":       tc.id,
            "type":     "function",
            "function": {
                "name":      tc.function.name,
                "arguments": tc.function.arguments,
            },
        })

    usage = getattr(response, "usage", None)
    usage_dict: Optional[Dict[str, Any]] = None
    if usage:
        usage_dict = {
            "prompt_tokens":     getattr(usage, "prompt_tokens", 0),
            "completion_tokens": getattr(usage, "completion_tokens", 0),
            "total_tokens":      getattr(usage, "total_tokens", 0),
        }

    return content, tool_calls, usage_dict

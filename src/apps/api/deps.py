"""
Shared application state and helpers.

All routers import from here so that patching in tests only needs to target
a single module (``deps``) rather than every individual router.
"""

import logging
import os
import re
import sys
import asyncio
import httpx
from pathlib import Path
from typing import Optional

from fastapi import HTTPException
from sqlite_client import SQLiteClient
from mitmproxy_manager import MitmproxyManager

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Singletons
# ---------------------------------------------------------------------------

db_client = SQLiteClient()
mitm_manager = MitmproxyManager()


# ---------------------------------------------------------------------------
# AI config env-var defaults
# ---------------------------------------------------------------------------

OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "google/gemini-3-flash-preview")


# ---------------------------------------------------------------------------
# Dynamic AI config (populated from DB by setup wizard; overrides env vars)
# ---------------------------------------------------------------------------

# These are module-level mutable values so that reload_ai_config() can update
# them in-place without restarting the process.  All routers that need the
# active AI config should call get_ai_config() rather than reading these directly.

_ai_provider:      str = ""   # e.g. "openrouter", "openai", "anthropic", "ollama"
_ai_api_key:       str = ""   # API key for cloud providers
_ai_provisioning:  str = ""   # OpenRouter provisioning key (optional)
_ai_base_url:      str = ""   # Base URL (cloud default or local override)
_ai_model:         str = ""   # Default model identifier
_ai_format:        str = ""   # "openai" | "anthropic"

_PROVIDER_BASE_URLS = {
    "openrouter": "https://openrouter.ai/api/v1",
    "openai":     "https://api.openai.com/v1",
    "anthropic":  "https://api.anthropic.com/v1",
    "gemini":     "https://generativelanguage.googleapis.com/v1beta/openai",
    "deepseek":   "https://api.deepseek.com/v1",
    "mistral":    "https://api.mistral.ai/v1",
    "ollama":     "http://localhost:11434/v1",
    "lmstudio":   "http://localhost:1234/v1",
}

_PROVIDER_FORMAT = {
    "openrouter": "openai",
    "openai":     "openai",
    "anthropic":  "anthropic",
    "gemini":     "openai",
    "deepseek":   "openai",
    "mistral":    "openai",
    "ollama":     "openai",
    "lmstudio":   "openai",
}


async def reload_ai_config() -> None:
    """Load AI provider settings from the DB and update module-level state.

    Called once at startup (after DB init) and again whenever the setup wizard
    saves new configuration so that in-flight requests immediately use the new
    provider without a container restart.
    """
    global _ai_provider, _ai_api_key, _ai_provisioning, _ai_base_url, _ai_model, _ai_format

    provider     = await db_client.get_setting("ai_provider")         or ""
    api_key      = await db_client.get_setting("ai_api_key")          or ""
    prov_key     = await db_client.get_setting("ai_provisioning_key") or ""
    base_url     = await db_client.get_setting("ai_base_url")         or ""
    model        = await db_client.get_setting("ai_model")            or ""

    if provider and provider not in ("skip", ""):
        _ai_provider     = provider
        _ai_api_key      = api_key
        _ai_provisioning = prov_key
        _ai_base_url     = base_url or _PROVIDER_BASE_URLS.get(provider, "")
        _ai_model        = model
        _ai_format       = _PROVIDER_FORMAT.get(provider, "openai")
        _log.info("AI config loaded from DB: provider=%s model=%s", provider, model)
    else:
        _log.info("AI config: setup not complete — AI features unavailable until wizard is run")


def get_ai_config() -> dict:
    """Return the current active AI configuration as a plain dict.

    Keys: provider, api_key, provisioning_key, base_url, model, format
    """
    return {
        "provider":         _ai_provider,
        "api_key":          _ai_api_key,
        "provisioning_key": _ai_provisioning,
        "base_url":         _ai_base_url,
        "model":            _ai_model,
        "format":           _ai_format,
    }


# ---------------------------------------------------------------------------
# Tests directory (host-mounted via docker-compose)
# ---------------------------------------------------------------------------

TESTS_DIR = Path(os.getenv("FERRET_TESTS_DIR", "/tests"))
SANDBOX_CONTAINER = os.getenv("FERRET_SANDBOX_CONTAINER", "ferret-lab")

# ---------------------------------------------------------------------------
# Workspaces directory (host-mounted via docker-compose)
# Each workspace gets: {WORKSPACES_DIR}/{project_id}/{session_id}/{scripts,tests,notes}/
# ---------------------------------------------------------------------------

WORKSPACES_DIR = Path(os.getenv("FERRET_WORKSPACES_DIR", "/data/workspaces"))


# ---------------------------------------------------------------------------
# AI helpers
# ---------------------------------------------------------------------------

def openrouter_headers(api_key: str) -> dict:
    """Build Authorization headers for an OpenRouter API call."""
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


async def get_key_for_project(project_id: str) -> Optional[str]:
    """Return the best available API key for a project.

    Resolution order:
    1. Provisioned sub-key stored in the DB for this project (OR provisioning flow).
    2. The global API key saved by the setup wizard (``_ai_api_key``).
    3. None — caller should raise a 503.

    This means that when a user configures OpenRouter (or any cloud provider)
    via the setup wizard but hasn't provisioned per-project sub-keys, their
    main API key is used as a fallback so chat still works.
    """
    provisioned = await db_client.get_active_key_for_project(project_id)
    if provisioned:
        return provisioned
    # Fall back to the global key from the setup wizard (may be "" if not configured)
    return _ai_api_key or None


# ---------------------------------------------------------------------------
# Code / test helpers
# ---------------------------------------------------------------------------

def strip_fences(code: str) -> str:
    """Remove leading/trailing markdown code fences if present."""
    code = re.sub(r"^```[a-zA-Z]*\n?", "", code.strip())
    code = re.sub(r"\n?```$", "", code.strip())
    return code.strip()


def safe_slug(text: str) -> str:
    """Convert arbitrary text to a filesystem-safe slug."""
    return re.sub(r"[^a-zA-Z0-9_-]", "_", text)[:40]


def test_file_path(request_id: str, host: str) -> Path:
    """Return a stable, host-organised path for the test file."""
    host_slug = safe_slug(host or "unknown")
    dir_path = TESTS_DIR / host_slug / request_id
    dir_path.mkdir(parents=True, exist_ok=True)
    return dir_path / "test_security.py"


async def run_pytest(test_path: Path) -> str:
    """Run pytest on *test_path* inside the ferret-lab sandbox container.

    ``-s`` disables output capture so that ``print()`` calls inside test
    functions are included in the returned output.  This is critical for the
    AI agent: without it, diagnostic prints (e.g. cart totals, HTTP status
    codes) are swallowed by pytest and never reach the model's context window.
    """
    proc = await asyncio.create_subprocess_exec(
        "docker", "exec", SANDBOX_CONTAINER,
        "python3", "-m", "pytest", str(test_path),
        "--tb=short", "-v", "--no-header", "-s",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await proc.communicate()
    return stdout.decode("utf-8", errors="replace")


def server_error(exc: Exception) -> HTTPException:
    """Log *exc* server-side and return a generic 500 HTTPException.

    Use this instead of ``HTTPException(status_code=500, detail=str(exc))``
    so that internal error details (stack traces, file paths, DB messages)
    are never sent to the client.

    Usage::

        except Exception as e:
            raise deps.server_error(e)
    """
    _log.exception("Unhandled server error: %s", exc)
    return HTTPException(status_code=500, detail="Internal server error")

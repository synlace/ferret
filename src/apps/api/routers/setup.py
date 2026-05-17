"""
First-run setup wizard endpoints.

GET  /api/setup        → returns { setup_complete, provider, model }
POST /api/setup        → saves provider config, marks setup complete
POST /api/setup/test   → tests connectivity to the configured provider
DELETE /api/setup      → resets setup (for re-configuration)
"""

import logging
import httpx
from fastapi import APIRouter, HTTPException
from passlib.context import CryptContext

import deps
from models import SetupConfig, SetupStatus

_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

_log = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Settings keys used in the DB
# ---------------------------------------------------------------------------

_KEY_SETUP_COMPLETE  = "setup_complete"
_KEY_AI_PROVIDER     = "ai_provider"
_KEY_AI_API_KEY      = "ai_api_key"
_KEY_AI_PROV_KEY     = "ai_provisioning_key"   # OpenRouter provisioning key (optional)
_KEY_AI_BASE_URL     = "ai_base_url"
_KEY_AI_MODEL        = "ai_model"

# ---------------------------------------------------------------------------
# Provider metadata (mirrors mockup / tabari provider-manager)
# ---------------------------------------------------------------------------

_CLOUD_PROVIDERS = {"openrouter", "openai", "anthropic", "gemini", "deepseek", "mistral"}
_LOCAL_PROVIDERS = {"ollama", "lmstudio"}

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
    # "openai" = OpenAI-compatible chat completions
    # "anthropic" = Anthropic messages API
    "openrouter": "openai",
    "openai":     "openai",
    "anthropic":  "anthropic",
    "gemini":     "openai",
    "deepseek":   "openai",
    "mistral":    "openai",
    "ollama":     "openai",
    "lmstudio":   "openai",
}


# ---------------------------------------------------------------------------
# base_url validation helper
# ---------------------------------------------------------------------------

def _validate_base_url(base_url: str, provider: str) -> None:
    """Prevent base_url from being set to attacker-controlled hosts.

    Rules:
    - Cloud providers: base_url override is never permitted (they have fixed endpoints).
    - Local providers: any URL is accepted EXCEPT those pointing at the internal
      Docker Compose service names (docker-proxy, api, ui, lab) which would allow
      the operator to pivot through the API container to internal services.
    """
    if not base_url:
        return
    from urllib.parse import urlparse
    parsed = urlparse(base_url)
    host = (parsed.hostname or "").lower()
    if provider in _CLOUD_PROVIDERS:
        # Cloud providers have fixed base URLs; override is not permitted
        raise HTTPException(
            status_code=422,
            detail=f"base_url override is not permitted for cloud provider {provider!r}",
        )
    if provider in _LOCAL_PROVIDERS:
        # Block internal Docker Compose service names to prevent SSRF pivoting
        _BLOCKED_SERVICE_NAMES = frozenset({"docker-proxy", "api", "ui", "lab"})
        if host in _BLOCKED_SERVICE_NAMES:
            raise HTTPException(
                status_code=422,
                detail=f"base_url must not target internal service {host!r}",
            )


# ---------------------------------------------------------------------------
# GET /api/setup
# ---------------------------------------------------------------------------

@router.get("/api/setup", response_model=SetupStatus)
async def get_setup_status():
    """Return whether first-run setup has been completed and the active config."""
    try:
        complete = await deps.db_client.get_setting(_KEY_SETUP_COMPLETE)
        if complete != "1":
            return SetupStatus(setup_complete=False)
        provider = await deps.db_client.get_setting(_KEY_AI_PROVIDER)
        model    = await deps.db_client.get_setting(_KEY_AI_MODEL)
        return SetupStatus(setup_complete=True, provider=provider, model=model)
    except Exception as e:
        raise deps.server_error(e)


# ---------------------------------------------------------------------------
# POST /api/setup
# ---------------------------------------------------------------------------

@router.post("/api/setup", status_code=201)
async def complete_setup(body: SetupConfig):
    """
    Save the AI provider configuration and mark setup as complete.

    For cloud providers an ``api_key`` is required.
    For local providers (Ollama, LM Studio) a ``base_url`` is optional
    (defaults to the well-known localhost address).
    """
    try:
        # Password is required for POST /api/setup (not for /test).
        if not body.password or len(body.password) < 8:
            raise HTTPException(
                status_code=422,
                detail="password is required and must be at least 8 characters",
            )

        provider = body.provider.lower()

        # "skip" is no longer supported — password is mandatory.
        if provider == "skip":
            raise HTTPException(
                status_code=422,
                detail="'skip' provider is no longer supported — a password and provider are required",
            )

        if provider not in _CLOUD_PROVIDERS and provider not in _LOCAL_PROVIDERS:
            raise HTTPException(status_code=422, detail=f"Unknown provider: {provider!r}")

        # OpenRouter accepts either an api_key (regular key) or a provisioning_key alone.
        # All other cloud providers require an api_key.
        if provider in _CLOUD_PROVIDERS:
            if provider == "openrouter":
                if not body.api_key and not body.provisioning_key:
                    raise HTTPException(
                        status_code=422,
                        detail="api_key or provisioning_key is required for OpenRouter",
                    )
            else:
                if not body.api_key:
                    raise HTTPException(
                        status_code=422,
                        detail="api_key is required for cloud providers",
                    )

        # Validate and resolve base URL
        _validate_base_url(body.base_url or "", provider)
        base_url = body.base_url or _PROVIDER_BASE_URLS.get(provider, "")

        # Hash and store the instance password before marking setup complete.
        password_hash = _pwd_ctx.hash(body.password)
        await deps.db_client.set_password_hash(password_hash)

        await deps.db_client.set_setting(_KEY_AI_PROVIDER, provider)
        await deps.db_client.set_setting(_KEY_AI_MODEL,    body.model)
        await deps.db_client.set_setting(_KEY_AI_BASE_URL, base_url)
        if body.api_key:
            await deps.db_client.set_setting(_KEY_AI_API_KEY, body.api_key)
        if body.provisioning_key:
            await deps.db_client.set_setting(_KEY_AI_PROV_KEY, body.provisioning_key)
        await deps.db_client.set_setting(_KEY_SETUP_COMPLETE, "1")

        # Reload the in-process AI config so new requests use the new settings
        # without requiring a container restart.
        await deps.reload_ai_config()

        _log.info("Setup completed: provider=%s model=%s", provider, body.model)
        return {"status": "ok", "provider": provider, "model": body.model}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


# ---------------------------------------------------------------------------
# POST /api/setup/test
# ---------------------------------------------------------------------------

@router.post("/api/setup/test")
async def test_setup_connection(body: SetupConfig):
    """
    Probe the provider endpoint with the supplied credentials.
    Returns { ok: bool, error?: str }.

    Each provider uses an auth-gated endpoint so that invalid keys are caught:
    - OpenRouter (api_key):        GET /auth/key          — requires Bearer token
    - OpenRouter (prov_key only):  GET /keys              — requires Bearer token
    - OpenAI / Gemini / etc.:      GET /models            — requires Bearer token
    - Anthropic:                   GET /models            — requires x-api-key header
    - Local (Ollama / LM Studio):  GET /models            — no auth, connectivity only
    """
    try:
        provider = body.provider.lower()
        _validate_base_url(body.base_url or "", provider)
        base_url = body.base_url or _PROVIDER_BASE_URLS.get(provider, "")
        fmt      = _PROVIDER_FORMAT.get(provider, "openai")

        if provider == "openrouter":
            return await _test_openrouter(body.api_key or "", body.provisioning_key or "", base_url)
        elif fmt == "anthropic":
            return await _test_anthropic(body.api_key or "", base_url)
        elif provider in _LOCAL_PROVIDERS:
            return await _test_local(base_url, provider)
        else:
            return await _test_openai_compat(body.api_key or "", base_url, provider)
    except HTTPException:
        raise
    except Exception as e:
        _log.warning("Setup test failed: %s", e)
        return {"ok": False, "error": str(e)}


async def _test_openrouter(api_key: str, provisioning_key: str, base_url: str) -> dict:
    """
    Test OpenRouter credentials.

    - api_key only:          GET /auth/key  (auth-gated)
    - provisioning_key only: GET /keys      (provisioning API, auth-gated)
    - Both keys provided:    test BOTH independently in parallel.

    Returns:
        { ok: bool, error?: str,
          key_results?: [{ label: str, ok: bool, error?: str }, ...] }

    key_results is only present when both keys are tested, so the UI can
    render one status line per key.
    """
    if not api_key and not provisioning_key:
        return {"ok": False, "error": "No key provided"}

    async def _check(key: str, url: str, label: str) -> dict:
        """Returns { label, ok, error? }."""
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(url, headers=headers)
            if r.status_code == 200:
                return {"label": label, "ok": True}
            if r.status_code in (401, 403):
                return {"label": label, "ok": False, "error": "Invalid key — check and try again"}
            return {"label": label, "ok": False, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
        except httpx.ConnectError as e:
            return {"label": label, "ok": False, "error": f"Could not reach OpenRouter: {e}"}
        except Exception as e:
            return {"label": label, "ok": False, "error": str(e)}

    import asyncio as _asyncio

    # Single key — simple response
    if api_key and not provisioning_key:
        result = await _check(api_key, base_url.rstrip("/") + "/auth/key", "API key")
        return {"ok": result["ok"], "error": result.get("error")} if not result["ok"] else {"ok": True}

    if provisioning_key and not api_key:
        result = await _check(provisioning_key, "https://openrouter.ai/api/v1/keys", "Provisioning key")
        return {"ok": result["ok"], "error": result.get("error")} if not result["ok"] else {"ok": True}

    # Both keys — test in parallel, return per-key results
    api_result, prov_result = await _asyncio.gather(
        _check(api_key, base_url.rstrip("/") + "/auth/key", "API key"),
        _check(provisioning_key, "https://openrouter.ai/api/v1/keys", "Provisioning key"),
    )
    overall_ok = api_result["ok"] and prov_result["ok"]
    return {
        "ok": overall_ok,
        "key_results": [api_result, prov_result],
    }


async def _test_openai_compat(api_key: str, base_url: str, provider: str) -> dict:
    """Hit /models on an OpenAI-compatible endpoint (requires auth for cloud providers)."""
    if not api_key:
        return {"ok": False, "error": "No API key provided"}

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    url = base_url.rstrip("/") + "/models"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url, headers=headers)
        if r.status_code == 200:
            return {"ok": True}
        if r.status_code in (401, 403):
            return {"ok": False, "error": "Invalid API key — check your key and try again"}
        return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
    except httpx.ConnectError as e:
        return {"ok": False, "error": f"Connection refused — is {provider} running? ({e})"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def _test_local(base_url: str, provider: str) -> dict:
    """Hit /models on a local provider — no auth required, connectivity check only."""
    url = base_url.rstrip("/") + "/models"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url)
        if r.status_code in (200, 206):
            return {"ok": True}
        return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
    except httpx.ConnectError as e:
        return {"ok": False, "error": f"Connection refused — is {provider} running? ({e})"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def _test_anthropic(api_key: str, base_url: str) -> dict:
    """Hit Anthropic /models endpoint — requires x-api-key header."""
    if not api_key:
        return {"ok": False, "error": "No API key provided"}

    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    url = base_url.rstrip("/") + "/models"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url, headers=headers)
        if r.status_code == 200:
            return {"ok": True}
        if r.status_code in (401, 403):
            return {"ok": False, "error": "Invalid API key — check your key and try again"}
        return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------------------
# DELETE /api/setup  (reset — allows re-running the wizard)
# ---------------------------------------------------------------------------

@router.delete("/api/setup", status_code=204)
async def reset_setup():
    """Clear the setup flag, credentials, and all sessions so the wizard is shown again."""
    try:
        await deps.db_client.set_setting(_KEY_SETUP_COMPLETE, "0")
        await deps.db_client.delete_credentials()
        await deps.db_client.delete_all_sessions()
        _log.info("Setup reset: credentials and sessions cleared")
    except Exception as e:
        raise deps.server_error(e)

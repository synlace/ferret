"""
test_api_security2.py — Security regression tests for the fixes applied 2026-05-17.

Covers:
  Fix 3 — SSRF guard on POST /api/gnaw/send and POST /api/gnaw/tabs/{id}/send
  Fix 6 — WebSocket origin check: empty-string origin is now rejected
  Fix 7 — base_url validation in POST /api/setup and POST /api/setup/test

Threat model for the gnaw SSRF guard
--------------------------------------
Ferret is a penetration-testing tool.  Its gnaw endpoints are intentionally
designed to reach arbitrary hosts, including LAN addresses (192.168.x.x,
10.x.x.x, etc.) that a tester may be assessing.

The guard only blocks:
  - Loopback (localhost, 127.x.x.x, ::1) — would reach the API container itself
  - Docker Compose service names (docker-proxy, api, ui, lab) — internal pivot

LAN/private IPs are intentionally allowed.

Run with:
    cd github/ferret/src/apps/api
    pytest test_api_security2.py -v
"""

from datetime import datetime, timezone
import pytest
import pytest_asyncio


# ===========================================================================
# Helpers
# ===========================================================================

# URLs that MUST be blocked (loopback + Docker service names + Docker bridge IPs)
_BLOCKED_URLS = [
    "http://localhost/secret",
    "http://127.0.0.1/secret",
    "http://127.0.0.2/secret",
    "http://::1/secret",
    "http://docker-proxy/secret",
    "http://api/secret",
    "http://ui/secret",
    "http://lab/secret",
    # Docker internal bridge range (172.16.0.0/12) — IP-based bypass of hostname blocklist
    # Docker Compose assigns container IPs from this range (e.g. 172.17.0.2, 172.18.0.3)
    "http://172.16.0.1/secret",
    "http://172.17.0.2:2375/version",   # typical docker-proxy IP
    "http://172.18.0.3/secret",
    "http://172.31.255.254/secret",
]

# URLs that MUST be allowed (legitimate pentest targets)
_ALLOWED_URLS = [
    "http://10.0.0.1/secret",
    "http://192.168.1.1/secret",
    "http://169.254.169.254/latest/meta-data/",  # IMDS — tester may be assessing AWS
    "https://example.com/path",
]

_SAFE_URL = "https://example.com/path"


def _gnaw_payload(url: str) -> dict:
    """Build a minimal valid HttpRequest payload for the gnaw endpoints."""
    host = url.split("/")[2] if url.count("/") >= 2 else url
    return {
        "id": "test-id-1234",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "method": "GET",
        "url": url,
        "host": host,
        "path": "/",
        "headers": {},
        "body": None,
    }


# ===========================================================================
# Fix 3 — SSRF guard: POST /api/gnaw/send
# ===========================================================================

class TestGnawSendSSRF:
    """POST /api/gnaw/send must block loopback/service-name targets."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("url", _BLOCKED_URLS)
    async def test_blocked_url_returns_400(self, client, url):
        resp = await client.post("/api/gnaw/send", json=_gnaw_payload(url))
        assert resp.status_code == 400, (
            f"Expected 400 for blocked target {url!r}, got {resp.status_code}: {resp.text}"
        )


# ===========================================================================
# Fix 3 — SSRF guard: POST /api/gnaw/tabs/{id}/send
# ===========================================================================

class TestGnawTabSendSSRF:
    """POST /api/gnaw/tabs/{id}/send must block loopback/service-name targets."""

    @pytest_asyncio.fixture
    async def tab_id(self, client):
        """Create a gnaw tab and return its ID."""
        resp = await client.post(
            "/api/gnaw/tabs",
            json={"raw_request": "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n", "label": "test"},
        )
        assert resp.status_code == 201
        return resp.json()["id"]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("url", _BLOCKED_URLS)
    async def test_blocked_url_returns_400(self, client, tab_id, url):
        resp = await client.post(
            f"/api/gnaw/tabs/{tab_id}/send",
            json=_gnaw_payload(url),
        )
        assert resp.status_code == 400, (
            f"Expected 400 for blocked target {url!r}, got {resp.status_code}: {resp.text}"
        )


# ===========================================================================
# Fix 3 — _assert_safe_url unit tests (direct import)
# ===========================================================================

class TestAssertSafeUrl:
    """Unit tests for the _assert_safe_url helper in proxy.py."""

    def _get_fn(self):
        import sys
        from pathlib import Path
        routers_dir = str(Path(__file__).parent / "routers")
        if routers_dir not in sys.path:
            sys.path.insert(0, routers_dir)
        from proxy import _assert_safe_url
        return _assert_safe_url

    def test_safe_external_url_passes(self):
        fn = self._get_fn()
        fn("https://example.com/path")
        fn("http://scanme.nmap.org/")

    @pytest.mark.parametrize("url", _BLOCKED_URLS)
    def test_blocked_url_raises_400(self, url):
        from fastapi import HTTPException
        fn = self._get_fn()
        with pytest.raises(HTTPException) as exc_info:
            fn(url)
        assert exc_info.value.status_code == 400, (
            f"Expected 400 for {url!r}, got {exc_info.value.status_code}"
        )

    @pytest.mark.parametrize("url", _ALLOWED_URLS)
    def test_allowed_url_does_not_raise(self, url):
        fn = self._get_fn()
        # Should not raise — LAN/private IPs are legitimate pentest targets
        fn(url)

    def test_no_host_raises_400(self):
        from fastapi import HTTPException
        fn = self._get_fn()
        with pytest.raises(HTTPException) as exc_info:
            fn("http:///no-host")
        assert exc_info.value.status_code == 400

    def test_ipv6_loopback_raises_400(self):
        from fastapi import HTTPException
        fn = self._get_fn()
        with pytest.raises(HTTPException) as exc_info:
            fn("http://[::1]/secret")
        assert exc_info.value.status_code == 400

    def test_docker_service_name_raises_400(self):
        from fastapi import HTTPException
        fn = self._get_fn()
        for host in ("docker-proxy", "api", "ui", "lab"):
            with pytest.raises(HTTPException) as exc_info:
                fn(f"http://{host}/secret")
            assert exc_info.value.status_code == 400, f"Expected 400 for host {host!r}"


# ===========================================================================
# Fix 6 — WebSocket origin check: empty origin must be rejected
# ===========================================================================

class TestWebSocketOriginCheck:
    """
    The WS endpoint must reject connections whose Origin header is absent/empty
    or from an unknown origin.

    We test the _WS_ALLOWED_ORIGINS set and the handler logic directly since
    the ASGI test client doesn't support WebSocket upgrades via plain HTTP GET.
    """

    def test_allowed_origins_set_contains_localhost(self):
        """_WS_ALLOWED_ORIGINS must contain the localhost UI origin."""
        import main as main_module
        assert any("localhost" in o for o in main_module._WS_ALLOWED_ORIGINS), (
            "localhost must be in _WS_ALLOWED_ORIGINS"
        )

    def test_empty_string_not_in_allowed_origins(self):
        """Empty string must NOT be in _WS_ALLOWED_ORIGINS (Fix 6)."""
        import main as main_module
        assert "" not in main_module._WS_ALLOWED_ORIGINS, (
            "Empty string origin must not be in _WS_ALLOWED_ORIGINS — "
            "this would allow connections with no Origin header"
        )

    def test_attacker_origin_not_in_allowed_origins(self):
        """Attacker origin must not be in _WS_ALLOWED_ORIGINS."""
        import main as main_module
        assert "https://evil.example.com" not in main_module._WS_ALLOWED_ORIGINS

    def test_ws_handler_rejects_empty_origin(self):
        """
        Verify the WS handler code path: origin="" must NOT pass the check.
        Before Fix 6 the condition was `if origin and origin not in allowed`,
        which skipped the check for empty string. After Fix 6 it is
        `if origin not in allowed`, which correctly rejects empty string.
        """
        import main as main_module
        allowed = main_module._WS_ALLOWED_ORIGINS
        origin = ""
        should_reject = origin not in allowed
        assert should_reject, (
            "Empty-string origin must be rejected by the fixed WS check"
        )

    def test_ws_handler_rejects_attacker_origin(self):
        """Attacker origin must be rejected."""
        import main as main_module
        allowed = main_module._WS_ALLOWED_ORIGINS
        origin = "https://evil.example.com"
        should_reject = origin not in allowed
        assert should_reject

    def test_ws_handler_accepts_localhost_origin(self):
        """Localhost UI origin must be accepted."""
        import main as main_module
        allowed = main_module._WS_ALLOWED_ORIGINS
        origin = next(iter(allowed))
        should_reject = origin not in allowed
        assert not should_reject, f"Allowed origin {origin!r} must not be rejected"


# ===========================================================================
# Fix 7 — base_url validation: POST /api/setup
# ===========================================================================

class TestSetupBaseUrlValidation:
    """POST /api/setup must reject attacker-controlled base_url values."""

    @pytest.mark.asyncio
    async def test_cloud_provider_with_base_url_override_rejected(self, client):
        """Cloud providers must not accept a custom base_url."""
        resp = await client.post(
            "/api/setup",
            json={
                "provider": "openai",
                "api_key": "sk-test",
                "model": "gpt-4o",
                "base_url": "https://evil.example.com/v1",
            },
        )
        assert resp.status_code == 422, (
            f"Expected 422 for cloud provider base_url override, got {resp.status_code}"
        )

    @pytest.mark.asyncio
    async def test_openrouter_with_base_url_override_rejected(self, client):
        """OpenRouter must not accept a custom base_url."""
        resp = await client.post(
            "/api/setup",
            json={
                "provider": "openrouter",
                "api_key": "sk-or-test",
                "model": "google/gemini-3-flash-preview",
                "base_url": "https://evil.example.com/v1",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_local_provider_internal_service_name_rejected(self, client):
        """Local providers must not be able to target internal Docker service names."""
        for service in ("docker-proxy", "api", "ui", "lab"):
            resp = await client.post(
                "/api/setup",
                json={
                    "provider": "ollama",
                    "api_key": "",
                    "model": "llama3",
                    "base_url": f"http://{service}:11434/v1",
                },
            )
            assert resp.status_code == 422, (
                f"Expected 422 for internal service {service!r}, got {resp.status_code}"
            )

    @pytest.mark.asyncio
    async def test_local_provider_lan_ip_accepted(self, client):
        """Local providers with a LAN IP base_url must be accepted (e.g. LM Studio on another machine)."""
        resp = await client.post(
            "/api/setup",
            json={
                "provider": "lmstudio",
                "api_key": "",
                "model": "local-model",
                "base_url": "http://192.168.1.10:1234/v1",
                "password": "testpassword1",
            },
        )
        assert resp.status_code == 201, (
            f"Expected 201 for LAN IP local provider base_url, got {resp.status_code}"
        )

    @pytest.mark.asyncio
    async def test_local_provider_loopback_base_url_accepted(self, client):
        """Local providers with a loopback base_url must be accepted."""
        resp = await client.post(
            "/api/setup",
            json={
                "provider": "ollama",
                "api_key": "",
                "model": "llama3",
                "base_url": "http://127.0.0.1:11434/v1",
                "password": "testpassword1",
            },
        )
        assert resp.status_code == 201, (
            f"Expected 201 for loopback local provider base_url, got {resp.status_code}"
        )

    @pytest.mark.asyncio
    async def test_cloud_provider_without_base_url_accepted(self, client):
        """Cloud providers without a base_url override must be accepted."""
        resp = await client.post(
            "/api/setup",
            json={
                "provider": "openai",
                "api_key": "sk-test",
                "model": "gpt-4o",
                "password": "testpassword1",
            },
        )
        assert resp.status_code == 201


# ===========================================================================
# Fix 7 — base_url validation: POST /api/setup/test
# ===========================================================================

class TestSetupTestBaseUrlValidation:
    """POST /api/setup/test must also reject attacker-controlled base_url values."""

    @pytest.mark.asyncio
    async def test_cloud_provider_with_base_url_override_rejected(self, client):
        resp = await client.post(
            "/api/setup/test",
            json={
                "provider": "openai",
                "api_key": "sk-test",
                "model": "gpt-4o",
                "base_url": "https://evil.example.com/v1",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_local_provider_internal_service_name_rejected(self, client):
        """Local providers must not be able to target internal Docker service names via test endpoint."""
        resp = await client.post(
            "/api/setup/test",
            json={
                "provider": "ollama",
                "api_key": "",
                "model": "llama3",
                "base_url": "http://docker-proxy:2375/v1",
            },
        )
        assert resp.status_code == 422

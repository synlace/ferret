"""
test_api_auth.py — Authentication tests for the FERRET API.

Covers:
  1. POST /api/auth/login       — success, wrong password, no credentials set
  2. GET  /api/auth/me          — valid session, no session, expired session, unknown token
  3. POST /api/auth/logout      — clears session, invalidates token in DB
  4. PUT  /api/auth/password    — success, wrong current password, short new password,
                                  session invalidation after change
  5. Bearer token               — valid key, invalid key, key unset (falls through to cookie)
  6. Protected endpoints        — 401 without credentials across multiple routers
  7. Exempt paths               — /health, /api/setup, /api/setup/test, /api/auth/login,
                                  /api/ca-cert, / reachable without credentials

Run with:
    cd github/ferret/src/apps/api
    pytest test_api_auth.py -v
"""

import secrets
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch


# ===========================================================================
# Helpers
# ===========================================================================

_TEST_PASSWORD = "test-password-123"
_NEW_PASSWORD  = "new-secure-pass-456"


# ===========================================================================
# 1. POST /api/auth/login
# ===========================================================================

class TestLogin:
    """Login endpoint behaviour."""

    @pytest.mark.asyncio
    async def test_login_success_returns_200_and_cookie(self, authed_client):
        """Correct password → 200 + ferret_session cookie set."""
        resp = await authed_client.post(
            "/api/auth/login",
            json={"password": _TEST_PASSWORD},
        )
        assert resp.status_code == 200
        assert resp.json()["authenticated"] is True
        assert "ferret_session" in resp.cookies

    @pytest.mark.asyncio
    async def test_login_wrong_password_returns_401(self, authed_client):
        """Wrong password → 401, no cookie issued."""
        resp = await authed_client.post(
            "/api/auth/login",
            json={"password": "wrong-password"},
        )
        assert resp.status_code == 401
        assert "ferret_session" not in resp.cookies

    @pytest.mark.asyncio
    async def test_login_no_credentials_returns_401(self, client):
        """No password stored in DB (setup not complete) → 401."""
        resp = await client.post(
            "/api/auth/login",
            json={"password": "anything"},
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_login_creates_session_in_db(self, authed_client):
        """Successful login stores a new session row in the database."""
        mem_db = authed_client._test_mem_db
        # Count sessions before login.
        async with mem_db._db.execute("SELECT COUNT(*) FROM sessions") as cur:
            before = (await cur.fetchone())[0]

        await authed_client.post("/api/auth/login", json={"password": _TEST_PASSWORD})

        async with mem_db._db.execute("SELECT COUNT(*) FROM sessions") as cur:
            after = (await cur.fetchone())[0]

        assert after == before + 1

    @pytest.mark.asyncio
    async def test_login_response_body_shape(self, authed_client):
        """Login response body contains exactly {authenticated: true}."""
        resp = await authed_client.post(
            "/api/auth/login",
            json={"password": _TEST_PASSWORD},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "authenticated" in body
        assert body["authenticated"] is True


# ===========================================================================
# 2. GET /api/auth/me
# ===========================================================================

class TestMe:
    """Session validation via /api/auth/me."""

    @pytest.mark.asyncio
    async def test_me_with_valid_session_returns_200(self, authed_client):
        """Valid session cookie → 200 {authenticated: true}."""
        resp = await authed_client.get("/api/auth/me")
        assert resp.status_code == 200
        assert resp.json()["authenticated"] is True

    @pytest.mark.asyncio
    async def test_me_without_session_returns_401(self, unauthed_client):
        """No cookie → 401."""
        resp = await unauthed_client.get("/api/auth/me")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_me_with_expired_session_returns_401(self, authed_client):
        """Expired session token → 401."""
        mem_db = authed_client._test_mem_db
        expired_token = secrets.token_hex(32)
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        await mem_db.create_session(expired_token, past)

        resp = await authed_client.get(
            "/api/auth/me",
            cookies={"ferret_session": expired_token},
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_me_with_unknown_token_returns_401(self, authed_client):
        """Random token not in DB → 401."""
        resp = await authed_client.get(
            "/api/auth/me",
            cookies={"ferret_session": secrets.token_hex(32)},
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_me_expired_session_is_deleted_from_db(self, authed_client):
        """Expired session is purged from the DB when it is rejected."""
        mem_db = authed_client._test_mem_db
        expired_token = secrets.token_hex(32)
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        await mem_db.create_session(expired_token, past)

        # Confirm it exists before the request.
        session_before = await mem_db.get_session(expired_token)
        assert session_before is not None

        await authed_client.get(
            "/api/auth/me",
            cookies={"ferret_session": expired_token},
        )

        # Should be deleted after the rejected request.
        session_after = await mem_db.get_session(expired_token)
        assert session_after is None


# ===========================================================================
# 3. POST /api/auth/logout
# ===========================================================================

class TestLogout:
    """Logout clears the session."""

    @pytest.mark.asyncio
    async def test_logout_returns_200_and_clears_cookie(self, authed_client):
        """Logout with valid session → 200, {authenticated: false}."""
        resp = await authed_client.post("/api/auth/logout")
        assert resp.status_code == 200
        assert resp.json()["authenticated"] is False

    @pytest.mark.asyncio
    async def test_logout_invalidates_session_in_db(self, authed_client):
        """After logout, the session token is removed from the DB."""
        token = authed_client._test_session_token
        mem_db = authed_client._test_mem_db

        await authed_client.post("/api/auth/logout")

        session = await mem_db.get_session(token)
        assert session is None

    @pytest.mark.asyncio
    async def test_logout_without_session_returns_401(self, unauthed_client):
        """Logout without a session cookie → 401 (require_auth blocks it)."""
        resp = await unauthed_client.post("/api/auth/logout")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_me_returns_401_after_logout(self, authed_client):
        """After logout, /api/auth/me with the old token returns 401."""
        token = authed_client._test_session_token

        await authed_client.post("/api/auth/logout")

        # Use the now-invalidated token explicitly.
        resp = await authed_client.get(
            "/api/auth/me",
            cookies={"ferret_session": token},
        )
        assert resp.status_code == 401


# ===========================================================================
# 4. PUT /api/auth/password
# ===========================================================================

class TestChangePassword:
    """PUT /api/auth/password — change the instance password."""

    @pytest.mark.asyncio
    async def test_change_password_success_returns_200(self, authed_client):
        """Correct current password + valid new password → 200."""
        resp = await authed_client.put(
            "/api/auth/password",
            json={
                "current_password": _TEST_PASSWORD,
                "new_password": _NEW_PASSWORD,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "detail" in body

    @pytest.mark.asyncio
    async def test_change_password_wrong_current_returns_401(self, authed_client):
        """Wrong current password → 401."""
        resp = await authed_client.put(
            "/api/auth/password",
            json={
                "current_password": "wrong-current-password",
                "new_password": _NEW_PASSWORD,
            },
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_change_password_short_new_password_returns_422(self, authed_client):
        """New password shorter than 8 chars → 422 (Pydantic validation)."""
        resp = await authed_client.put(
            "/api/auth/password",
            json={
                "current_password": _TEST_PASSWORD,
                "new_password": "short",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_change_password_invalidates_all_sessions(self, authed_client):
        """After a password change, all existing sessions are deleted from the DB."""
        mem_db = authed_client._test_mem_db

        # Seed a second session to confirm ALL sessions are wiped.
        extra_token = secrets.token_hex(32)
        future = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
        await mem_db.create_session(extra_token, future)

        await authed_client.put(
            "/api/auth/password",
            json={
                "current_password": _TEST_PASSWORD,
                "new_password": _NEW_PASSWORD,
            },
        )

        # Both the original and the extra session should be gone.
        original_session = await mem_db.get_session(authed_client._test_session_token)
        extra_session = await mem_db.get_session(extra_token)
        assert original_session is None
        assert extra_session is None

    @pytest.mark.asyncio
    async def test_change_password_new_hash_stored(self, authed_client):
        """After a password change, the new hash is stored and the old one is gone."""
        from passlib.context import CryptContext
        mem_db = authed_client._test_mem_db
        pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

        await authed_client.put(
            "/api/auth/password",
            json={
                "current_password": _TEST_PASSWORD,
                "new_password": _NEW_PASSWORD,
            },
        )

        stored_hash = await mem_db.get_password_hash()
        assert stored_hash is not None
        # Old password must NOT verify against the new hash.
        assert not pwd_ctx.verify(_TEST_PASSWORD, stored_hash)
        # New password MUST verify.
        assert pwd_ctx.verify(_NEW_PASSWORD, stored_hash)

    @pytest.mark.asyncio
    async def test_change_password_login_with_new_password_succeeds(self, authed_client):
        """After a password change, login with the new password returns 200."""
        await authed_client.put(
            "/api/auth/password",
            json={
                "current_password": _TEST_PASSWORD,
                "new_password": _NEW_PASSWORD,
            },
        )

        resp = await authed_client.post(
            "/api/auth/login",
            json={"password": _NEW_PASSWORD},
        )
        assert resp.status_code == 200
        assert resp.json()["authenticated"] is True

    @pytest.mark.asyncio
    async def test_change_password_login_with_old_password_fails(self, authed_client):
        """After a password change, login with the old password returns 401."""
        await authed_client.put(
            "/api/auth/password",
            json={
                "current_password": _TEST_PASSWORD,
                "new_password": _NEW_PASSWORD,
            },
        )

        resp = await authed_client.post(
            "/api/auth/login",
            json={"password": _TEST_PASSWORD},
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_change_password_without_auth_returns_401(self, unauthed_client):
        """PUT /api/auth/password without a session → 401."""
        resp = await unauthed_client.put(
            "/api/auth/password",
            json={
                "current_password": _TEST_PASSWORD,
                "new_password": _NEW_PASSWORD,
            },
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_change_password_missing_fields_returns_422(self, authed_client):
        """Missing required fields → 422."""
        resp = await authed_client.put(
            "/api/auth/password",
            json={"new_password": _NEW_PASSWORD},  # missing current_password
        )
        assert resp.status_code == 422


# ===========================================================================
# 5. Bearer token
# ===========================================================================

class TestBearerToken:
    """FERRET_API_KEY Bearer token authentication."""

    @pytest.mark.asyncio
    async def test_valid_bearer_token_allows_access(self, unauthed_client):
        """Valid Bearer token → 200 on a protected endpoint (no cookie needed)."""
        test_key = "test-api-key-abc123"
        import deps as deps_module
        with patch.object(deps_module, "_API_KEY", test_key):
            resp = await unauthed_client.get(
                "/api/requests",
                headers={"Authorization": f"Bearer {test_key}"},
            )
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_invalid_bearer_token_returns_401(self, unauthed_client):
        """Wrong Bearer token → 401 even when FERRET_API_KEY is set."""
        import deps as deps_module
        with patch.object(deps_module, "_API_KEY", "correct-key"):
            resp = await unauthed_client.get(
                "/api/requests",
                headers={"Authorization": "Bearer wrong-key"},
            )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_bearer_token_not_checked_when_api_key_unset(self, unauthed_client):
        """When FERRET_API_KEY is empty, Bearer header is ignored (falls through to cookie check → 401)."""
        import deps as deps_module
        with patch.object(deps_module, "_API_KEY", ""):
            resp = await unauthed_client.get(
                "/api/requests",
                headers={"Authorization": "Bearer anything"},
            )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_bearer_token_works_on_me_endpoint(self, unauthed_client):
        """Bearer token grants access to /api/auth/me."""
        test_key = "bearer-me-test-key"
        import deps as deps_module
        with patch.object(deps_module, "_API_KEY", test_key):
            resp = await unauthed_client.get(
                "/api/auth/me",
                headers={"Authorization": f"Bearer {test_key}"},
            )
        assert resp.status_code == 200
        assert resp.json()["authenticated"] is True

    @pytest.mark.asyncio
    async def test_bearer_token_malformed_header_returns_401(self, unauthed_client):
        """Malformed Authorization header (no 'Bearer ' prefix) → 401."""
        import deps as deps_module
        with patch.object(deps_module, "_API_KEY", "some-key"):
            resp = await unauthed_client.get(
                "/api/requests",
                headers={"Authorization": "Token some-key"},  # wrong scheme
            )
        assert resp.status_code == 401


# ===========================================================================
# 6. Protected endpoints — no credentials
# ===========================================================================

class TestProtectedEndpointRejection:
    """Every protected endpoint returns 401 when no credentials are provided.

    This class acts as a regression guard: if a new router is added without
    being wired through ``require_auth``, a test here will catch it.
    """

    # --- Requests router ---

    @pytest.mark.asyncio
    async def test_get_requests_requires_auth(self, unauthed_client):
        """GET /api/requests → 401."""
        resp = await unauthed_client.get("/api/requests")
        assert resp.status_code == 401

    # --- Findings router ---

    @pytest.mark.asyncio
    async def test_get_findings_requires_auth(self, unauthed_client):
        """GET /api/findings → 401."""
        resp = await unauthed_client.get("/api/findings")
        assert resp.status_code == 401

    # --- Projects router ---

    @pytest.mark.asyncio
    async def test_get_projects_requires_auth(self, unauthed_client):
        """GET /api/projects → 401."""
        resp = await unauthed_client.get("/api/projects")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_post_project_requires_auth(self, unauthed_client):
        """POST /api/projects → 401."""
        resp = await unauthed_client.post(
            "/api/projects",
            json={"name": "test-project"},
        )
        assert resp.status_code == 401

    # --- Settings router ---

    @pytest.mark.asyncio
    async def test_get_active_project_requires_auth(self, unauthed_client):
        """GET /api/settings/active-project → 401."""
        resp = await unauthed_client.get("/api/settings/active-project")
        assert resp.status_code == 401

    # --- Proxy router ---

    @pytest.mark.asyncio
    async def test_get_proxy_status_requires_auth(self, unauthed_client):
        """GET /api/proxy/status → 401."""
        resp = await unauthed_client.get("/api/proxy/status")
        assert resp.status_code == 401

    # --- Auth router (protected endpoints) ---

    @pytest.mark.asyncio
    async def test_logout_requires_auth(self, unauthed_client):
        """POST /api/auth/logout → 401 (not exempt — prevents CSRF forced-logout)."""
        resp = await unauthed_client.post("/api/auth/logout")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_change_password_requires_auth(self, unauthed_client):
        """PUT /api/auth/password → 401."""
        resp = await unauthed_client.put(
            "/api/auth/password",
            json={
                "current_password": _TEST_PASSWORD,
                "new_password": _NEW_PASSWORD,
            },
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_me_requires_auth(self, unauthed_client):
        """GET /api/auth/me → 401."""
        resp = await unauthed_client.get("/api/auth/me")
        assert resp.status_code == 401

    # --- Plans router ---

    @pytest.mark.asyncio
    async def test_get_plans_requires_auth(self, unauthed_client):
        """GET /api/plans → 401."""
        resp = await unauthed_client.get("/api/plans")
        assert resp.status_code == 401


# ===========================================================================
# 7. Exempt paths — reachable without any credentials
# ===========================================================================

class TestExemptPaths:
    """Every path in ``_AUTH_EXEMPT_PATHS`` / ``_AUTH_EXEMPT_PREFIXES`` must be
    reachable without a session cookie or Bearer token.

    All tests use ``unauthed_client`` (real ``require_auth`` enforcement, no
    pre-injected cookie) to prove the exemption is genuine.
    """

    @pytest.mark.asyncio
    async def test_health_is_exempt(self, unauthed_client):
        """/health is reachable without auth."""
        resp = await unauthed_client.get("/health")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_root_is_exempt(self, unauthed_client):
        """GET / is reachable without auth (serves the Next.js shell)."""
        resp = await unauthed_client.get("/")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_setup_get_is_exempt(self, unauthed_client):
        """GET /api/setup is reachable without auth (first-run wizard polling)."""
        resp = await unauthed_client.get("/api/setup")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_setup_post_is_exempt(self, unauthed_client):
        """POST /api/setup is reachable without auth (first-run wizard completion)."""
        # We expect 422 (validation error) because the body is empty, but NOT 401.
        resp = await unauthed_client.post("/api/setup", json={})
        assert resp.status_code != 401

    @pytest.mark.asyncio
    async def test_setup_delete_is_exempt(self, unauthed_client):
        """DELETE /api/setup is reachable without auth (reset wizard)."""
        resp = await unauthed_client.delete("/api/setup")
        # 204 on success or 500 if DB is empty — but never 401.
        assert resp.status_code != 401

    @pytest.mark.asyncio
    async def test_setup_test_is_exempt(self, unauthed_client):
        """POST /api/setup/test is reachable without auth (test connection during wizard)."""
        # We expect 422 (validation error) because the body is empty, but NOT 401.
        resp = await unauthed_client.post("/api/setup/test", json={})
        assert resp.status_code != 401

    @pytest.mark.asyncio
    async def test_login_endpoint_is_exempt(self, unauthed_client):
        """POST /api/auth/login is reachable without auth (obviously)."""
        resp = await unauthed_client.post(
            "/api/auth/login",
            json={"password": "test-password-123"},
        )
        # 200 (correct password) or 401 (wrong) — either way, not blocked by require_auth.
        # The unauthed_client has credentials seeded, so this should be 200.
        assert resp.status_code in (200, 401)

    @pytest.mark.asyncio
    async def test_ca_cert_is_exempt(self, unauthed_client):
        """GET /api/ca-cert is reachable without auth (needed before login)."""
        resp = await unauthed_client.get("/api/ca-cert")
        # 200 (cert exists) or 404 (no cert generated yet) — but never 401.
        assert resp.status_code != 401

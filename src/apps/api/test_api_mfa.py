"""
test_api_mfa.py — TOTP-based Multi-Factor Authentication tests for the FERRET API.

Covers:
  1. POST /api/auth/mfa/setup        — generates secret + QR code
  2. POST /api/auth/mfa/verify-setup — activates MFA with a valid code; rejects invalid code
  3. POST /api/auth/mfa/challenge    — exchanges pending cookie + TOTP code for full session
  4. POST /api/auth/mfa/disable      — disables MFA (requires password + TOTP code)
  5. GET  /api/auth/mfa/status       — returns mfa_enabled flag
  6. Login flow with MFA enabled     — issues ferret_pending cookie, not a full session
  7. Pending cookie rejection        — ferret_pending is rejected on protected routes

Run with:
    cd github/ferret/src/apps/api
    pytest test_api_mfa.py -v
"""

import pyotp
import pytest
import pytest_asyncio
from unittest.mock import patch

_TEST_PASSWORD = "test-password-123"


# ===========================================================================
# Helpers
# ===========================================================================

async def _enable_mfa(authed_client) -> str:
    """Helper: call setup + verify-setup to fully enable MFA.  Returns the TOTP secret."""
    # 1. Generate secret
    resp = await authed_client.post("/api/auth/mfa/setup")
    assert resp.status_code == 200
    secret = resp.json()["secret"]

    # 2. Confirm with a valid code
    totp = pyotp.TOTP(secret)
    resp2 = await authed_client.post(
        "/api/auth/mfa/verify-setup",
        json={"code": totp.now()},
    )
    assert resp2.status_code == 200
    return secret


# ===========================================================================
# 1. POST /api/auth/mfa/setup
# ===========================================================================

class TestMfaSetup:
    """Setup endpoint generates a TOTP secret and QR code."""

    @pytest.mark.asyncio
    async def test_setup_returns_200_with_secret_and_qr(self, authed_client):
        """Setup returns secret, otpauth_uri, and base64 QR PNG."""
        resp = await authed_client.post("/api/auth/mfa/setup")
        assert resp.status_code == 200
        body = resp.json()
        assert "secret" in body
        assert "otpauth_uri" in body
        assert "qr_png_b64" in body
        assert len(body["secret"]) >= 16  # base32 TOTP secret

    @pytest.mark.asyncio
    async def test_setup_otpauth_uri_contains_issuer(self, authed_client):
        """otpauth_uri contains the Ferret issuer name."""
        resp = await authed_client.post("/api/auth/mfa/setup")
        assert "Ferret" in resp.json()["otpauth_uri"]

    @pytest.mark.asyncio
    async def test_setup_stores_secret_in_db(self, authed_client):
        """After setup, the TOTP secret is stored in the DB."""
        mem_db = authed_client._test_mem_db
        await authed_client.post("/api/auth/mfa/setup")
        secret = await mem_db.get_totp_secret()
        assert secret is not None
        assert len(secret) >= 16

    @pytest.mark.asyncio
    async def test_setup_does_not_enable_mfa_yet(self, authed_client):
        """Setup alone does NOT activate MFA — verify-setup is required."""
        mem_db = authed_client._test_mem_db
        await authed_client.post("/api/auth/mfa/setup")
        assert not await mem_db.get_mfa_enabled()

    @pytest.mark.asyncio
    async def test_setup_requires_auth(self, unauthed_client):
        """POST /api/auth/mfa/setup → 401 without a session."""
        resp = await unauthed_client.post("/api/auth/mfa/setup")
        assert resp.status_code == 401


# ===========================================================================
# 2. POST /api/auth/mfa/verify-setup
# ===========================================================================

class TestMfaVerifySetup:
    """verify-setup activates MFA when the code is correct."""

    @pytest.mark.asyncio
    async def test_verify_setup_with_valid_code_returns_200(self, authed_client):
        """Valid TOTP code after setup → 200, MFA enabled."""
        resp = await authed_client.post("/api/auth/mfa/setup")
        secret = resp.json()["secret"]
        totp = pyotp.TOTP(secret)

        resp2 = await authed_client.post(
            "/api/auth/mfa/verify-setup",
            json={"code": totp.now()},
        )
        assert resp2.status_code == 200

    @pytest.mark.asyncio
    async def test_verify_setup_enables_mfa_in_db(self, authed_client):
        """After verify-setup, mfa_enabled is True in the DB."""
        mem_db = authed_client._test_mem_db
        await _enable_mfa(authed_client)
        assert await mem_db.get_mfa_enabled()

    @pytest.mark.asyncio
    async def test_verify_setup_with_invalid_code_returns_401(self, authed_client):
        """Wrong TOTP code → 401."""
        await authed_client.post("/api/auth/mfa/setup")
        resp = await authed_client.post(
            "/api/auth/mfa/verify-setup",
            json={"code": "000000"},
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_verify_setup_without_prior_setup_returns_400(self, authed_client):
        """verify-setup without calling setup first → 400."""
        resp = await authed_client.post(
            "/api/auth/mfa/verify-setup",
            json={"code": "123456"},
        )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_verify_setup_requires_auth(self, unauthed_client):
        """POST /api/auth/mfa/verify-setup → 401 without a session."""
        resp = await unauthed_client.post(
            "/api/auth/mfa/verify-setup",
            json={"code": "123456"},
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_verify_setup_short_code_returns_422(self, authed_client):
        """Code shorter than 6 digits → 422 (Pydantic validation)."""
        await authed_client.post("/api/auth/mfa/setup")
        resp = await authed_client.post(
            "/api/auth/mfa/verify-setup",
            json={"code": "123"},
        )
        assert resp.status_code == 422


# ===========================================================================
# 3. POST /api/auth/mfa/challenge
# ===========================================================================

class TestMfaChallenge:
    """challenge exchanges a pending cookie + TOTP code for a full session."""

    @pytest.mark.asyncio
    async def test_challenge_with_valid_code_issues_full_session(self, authed_client):
        """Valid pending cookie + valid TOTP code → 200 + ferret_session cookie."""
        import secrets as _secrets
        from datetime import datetime, timezone
        import deps as deps_module

        mem_db = authed_client._test_mem_db
        secret = await _enable_mfa(authed_client)

        # Manually create a pending session (simulating what login() does).
        pending_token = _secrets.token_hex(32)
        pending_expires = (
            datetime.now(timezone.utc) + deps_module.PENDING_TTL
        ).isoformat()
        await mem_db.create_session(f"pending:{pending_token}", pending_expires)

        totp = pyotp.TOTP(secret)
        resp = await authed_client.post(
            "/api/auth/mfa/challenge",
            json={"code": totp.now()},
            cookies={deps_module.PENDING_COOKIE: pending_token},
        )
        assert resp.status_code == 200
        assert resp.json()["authenticated"] is True
        assert deps_module.SESSION_COOKIE in resp.cookies

    @pytest.mark.asyncio
    async def test_challenge_with_invalid_code_returns_401(self, authed_client):
        """Valid pending cookie + wrong TOTP code → 401."""
        import secrets as _secrets
        from datetime import datetime, timezone
        import deps as deps_module

        mem_db = authed_client._test_mem_db
        await _enable_mfa(authed_client)

        pending_token = _secrets.token_hex(32)
        pending_expires = (
            datetime.now(timezone.utc) + deps_module.PENDING_TTL
        ).isoformat()
        await mem_db.create_session(f"pending:{pending_token}", pending_expires)

        resp = await authed_client.post(
            "/api/auth/mfa/challenge",
            json={"code": "000000"},
            cookies={deps_module.PENDING_COOKIE: pending_token},
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_challenge_without_pending_cookie_returns_401(self, authed_client):
        """No pending cookie → 401."""
        await _enable_mfa(authed_client)
        resp = await authed_client.post(
            "/api/auth/mfa/challenge",
            json={"code": "123456"},
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_challenge_consumes_pending_session(self, authed_client):
        """After a successful challenge, the pending session is deleted from the DB."""
        import secrets as _secrets
        from datetime import datetime, timezone
        import deps as deps_module

        mem_db = authed_client._test_mem_db
        secret = await _enable_mfa(authed_client)

        pending_token = _secrets.token_hex(32)
        pending_expires = (
            datetime.now(timezone.utc) + deps_module.PENDING_TTL
        ).isoformat()
        pending_key = f"pending:{pending_token}"
        await mem_db.create_session(pending_key, pending_expires)

        totp = pyotp.TOTP(secret)
        await authed_client.post(
            "/api/auth/mfa/challenge",
            json={"code": totp.now()},
            cookies={deps_module.PENDING_COOKIE: pending_token},
        )

        # Pending session must be gone.
        assert await mem_db.get_session(pending_key) is None


# ===========================================================================
# 4. POST /api/auth/mfa/disable
# ===========================================================================

class TestMfaDisable:
    """disable turns off MFA (requires password + TOTP code)."""

    @pytest.mark.asyncio
    async def test_disable_with_valid_credentials_returns_200(self, authed_client):
        """Correct password + valid TOTP code → 200, MFA disabled."""
        secret = await _enable_mfa(authed_client)
        totp = pyotp.TOTP(secret)

        resp = await authed_client.post(
            "/api/auth/mfa/disable",
            json={"current_password": _TEST_PASSWORD, "code": totp.now()},
        )
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_disable_clears_mfa_in_db(self, authed_client):
        """After disable, mfa_enabled is False and totp_secret is NULL."""
        mem_db = authed_client._test_mem_db
        secret = await _enable_mfa(authed_client)
        totp = pyotp.TOTP(secret)

        await authed_client.post(
            "/api/auth/mfa/disable",
            json={"current_password": _TEST_PASSWORD, "code": totp.now()},
        )

        assert not await mem_db.get_mfa_enabled()
        assert await mem_db.get_totp_secret() is None

    @pytest.mark.asyncio
    async def test_disable_wrong_password_returns_401(self, authed_client):
        """Wrong password → 401."""
        secret = await _enable_mfa(authed_client)
        totp = pyotp.TOTP(secret)

        resp = await authed_client.post(
            "/api/auth/mfa/disable",
            json={"current_password": "wrong-password", "code": totp.now()},
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_disable_wrong_code_returns_401(self, authed_client):
        """Correct password but wrong TOTP code → 401."""
        await _enable_mfa(authed_client)

        resp = await authed_client.post(
            "/api/auth/mfa/disable",
            json={"current_password": _TEST_PASSWORD, "code": "000000"},
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_disable_when_mfa_not_enabled_returns_400(self, authed_client):
        """Calling disable when MFA is not enabled → 400."""
        resp = await authed_client.post(
            "/api/auth/mfa/disable",
            json={"current_password": _TEST_PASSWORD, "code": "123456"},
        )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_disable_requires_auth(self, unauthed_client):
        """POST /api/auth/mfa/disable → 401 without a session."""
        resp = await unauthed_client.post(
            "/api/auth/mfa/disable",
            json={"current_password": _TEST_PASSWORD, "code": "123456"},
        )
        assert resp.status_code == 401


# ===========================================================================
# 5. GET /api/auth/mfa/status
# ===========================================================================

class TestMfaStatus:
    """status endpoint returns the current MFA state."""

    @pytest.mark.asyncio
    async def test_status_returns_false_when_mfa_disabled(self, authed_client):
        """mfa_enabled is False when MFA has not been set up."""
        resp = await authed_client.get("/api/auth/mfa/status")
        assert resp.status_code == 200
        assert resp.json()["mfa_enabled"] is False

    @pytest.mark.asyncio
    async def test_status_returns_true_after_enable(self, authed_client):
        """mfa_enabled is True after MFA is activated."""
        await _enable_mfa(authed_client)
        resp = await authed_client.get("/api/auth/mfa/status")
        assert resp.status_code == 200
        assert resp.json()["mfa_enabled"] is True

    @pytest.mark.asyncio
    async def test_status_requires_auth(self, unauthed_client):
        """GET /api/auth/mfa/status → 401 without a session."""
        resp = await unauthed_client.get("/api/auth/mfa/status")
        assert resp.status_code == 401


# ===========================================================================
# 6. Login flow with MFA enabled
# ===========================================================================

class TestLoginWithMfaEnabled:
    """When MFA is enabled, login issues a pending cookie instead of a full session."""

    @pytest.mark.asyncio
    async def test_login_with_mfa_enabled_returns_mfa_required(self, authed_client):
        """Login with MFA enabled → 200 + {mfa_required: true}."""
        await _enable_mfa(authed_client)

        resp = await authed_client.post(
            "/api/auth/login",
            json={"password": _TEST_PASSWORD},
            cookies={},  # no session cookie
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["mfa_required"] is True
        assert body["authenticated"] is False

    @pytest.mark.asyncio
    async def test_login_with_mfa_enabled_issues_pending_cookie(self, authed_client):
        """Login with MFA enabled sets a ferret_pending cookie."""
        import deps as deps_module
        await _enable_mfa(authed_client)

        resp = await authed_client.post(
            "/api/auth/login",
            json={"password": _TEST_PASSWORD},
            cookies={},
        )
        assert deps_module.PENDING_COOKIE in resp.cookies

    @pytest.mark.asyncio
    async def test_login_with_mfa_enabled_does_not_issue_full_session(self, authed_client):
        """Login with MFA enabled does NOT set a ferret_session cookie."""
        import deps as deps_module
        await _enable_mfa(authed_client)

        resp = await authed_client.post(
            "/api/auth/login",
            json={"password": _TEST_PASSWORD},
            cookies={},
        )
        assert deps_module.SESSION_COOKIE not in resp.cookies


# ===========================================================================
# 7. Pending cookie rejection on protected routes
# ===========================================================================

class TestPendingCookieRejection:
    """A ferret_pending cookie must NOT grant access to protected routes."""

    @pytest.mark.asyncio
    async def test_pending_cookie_rejected_on_requests_endpoint(self, authed_client):
        """ferret_pending cookie → 401 on GET /api/requests."""
        import secrets as _secrets
        from datetime import datetime, timezone
        import deps as deps_module

        mem_db = authed_client._test_mem_db
        await _enable_mfa(authed_client)

        pending_token = _secrets.token_hex(32)
        pending_expires = (
            datetime.now(timezone.utc) + deps_module.PENDING_TTL
        ).isoformat()
        await mem_db.create_session(f"pending:{pending_token}", pending_expires)

        resp = await authed_client.get(
            "/api/requests",
            cookies={
                deps_module.PENDING_COOKIE: pending_token,
                # Explicitly exclude the full session cookie.
                deps_module.SESSION_COOKIE: "",
            },
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_pending_cookie_rejected_on_me_endpoint(self, authed_client):
        """ferret_pending cookie → 401 on GET /api/auth/me."""
        import secrets as _secrets
        from datetime import datetime, timezone
        import deps as deps_module

        mem_db = authed_client._test_mem_db
        await _enable_mfa(authed_client)

        pending_token = _secrets.token_hex(32)
        pending_expires = (
            datetime.now(timezone.utc) + deps_module.PENDING_TTL
        ).isoformat()
        await mem_db.create_session(f"pending:{pending_token}", pending_expires)

        resp = await authed_client.get(
            "/api/auth/me",
            cookies={
                deps_module.PENDING_COOKIE: pending_token,
                deps_module.SESSION_COOKIE: "",
            },
        )
        assert resp.status_code == 401

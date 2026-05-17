"""
Authentication endpoints.

POST /api/auth/login            — validate password; issue session cookie (or pending cookie if MFA enabled)
POST /api/auth/logout           — delete session, clear cookie
GET  /api/auth/me               — return {authenticated: true} if session is valid
PUT  /api/auth/password         — change instance password (requires current password, invalidates all sessions)

MFA (TOTP) endpoints:
POST /api/auth/mfa/setup        — generate TOTP secret + QR code (stores secret, not yet active)
POST /api/auth/mfa/verify-setup — confirm 6-digit code, activate MFA
POST /api/auth/mfa/challenge    — exchange ferret_pending cookie + 6-digit code for a full session cookie
POST /api/auth/mfa/disable      — disable MFA (requires current password + valid TOTP code)
GET  /api/auth/mfa/status       — return {mfa_enabled: bool}
"""

import base64
import io
import logging
import secrets
from datetime import datetime, timezone

import pyotp
import qrcode
from fastapi import APIRouter, HTTPException, Request, Response
from passlib.context import CryptContext

import deps
from models import (
    AuthStatus,
    ChangePasswordRequest,
    LoginRequest,
    MfaDisableRequest,
    MfaSetupResponse,
    MfaVerifyRequest,
)

_log = logging.getLogger(__name__)

router = APIRouter()

# bcrypt context — same settings used when storing the hash during setup.
_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

# TOTP issuer name shown in authenticator apps.
_TOTP_ISSUER = "Ferret"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=deps.SESSION_COOKIE,
        value=token,
        httponly=True,
        samesite="lax",
        path="/",
        max_age=int(deps.SESSION_TTL.total_seconds()),
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=deps.SESSION_COOKIE, path="/", httponly=True, samesite="lax")


def _set_pending_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=deps.PENDING_COOKIE,
        value=token,
        httponly=True,
        samesite="lax",
        path="/",
        max_age=int(deps.PENDING_TTL.total_seconds()),
    )


def _clear_pending_cookie(response: Response) -> None:
    response.delete_cookie(key=deps.PENDING_COOKIE, path="/", httponly=True, samesite="lax")


# ---------------------------------------------------------------------------
# POST /api/auth/login
# ---------------------------------------------------------------------------

@router.post("/api/auth/login")
async def login(body: LoginRequest, response: Response):
    """Validate the instance password and issue a session cookie.

    If MFA is enabled, issues a short-lived ``ferret_pending`` cookie instead
    of a full session and returns ``{authenticated: false, mfa_required: true}``.
    The client must then POST to ``/api/auth/mfa/challenge`` with the TOTP code
    to exchange the pending cookie for a full session.

    Returns 200 + ``Set-Cookie: ferret_session=<token>; HttpOnly; SameSite=Lax``
    on success (no MFA), or 401 on failure.

    This endpoint is exempt from ``require_auth`` (listed in
    ``deps._AUTH_EXEMPT_PATHS``) so it can be reached before login.
    """
    password_hash = await deps.db_client.get_password_hash()
    if not password_hash:
        # No credentials stored — setup has not been completed yet.
        raise HTTPException(status_code=401, detail="Setup not complete")

    if not _pwd_ctx.verify(body.password, password_hash):
        _log.warning("Failed login attempt")
        raise HTTPException(status_code=401, detail="Incorrect password")

    mfa_enabled = await deps.db_client.get_mfa_enabled()

    if mfa_enabled:
        # Issue a short-lived pending cookie; the client must complete the TOTP
        # challenge before a full session is granted.
        pending_token = secrets.token_hex(32)
        pending_expires = (
            datetime.now(timezone.utc) + deps.PENDING_TTL
        ).isoformat()
        await deps.db_client.create_session(
            f"pending:{pending_token}", pending_expires
        )
        _set_pending_cookie(response, pending_token)
        _log.info("Login: password OK, MFA required — pending cookie issued")
        return AuthStatus(authenticated=False, mfa_required=True, mfa_enabled=True)

    # No MFA — issue a full session immediately.
    token = secrets.token_hex(32)
    expires_at = (
        datetime.now(timezone.utc) + deps.SESSION_TTL
    ).isoformat()
    await deps.db_client.create_session(token, expires_at)
    _set_session_cookie(response, token)

    _log.info("Login successful, session created")
    return AuthStatus(authenticated=True, mfa_required=False, mfa_enabled=False)


# ---------------------------------------------------------------------------
# POST /api/auth/logout
# ---------------------------------------------------------------------------

@router.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    """Delete the current session and clear the cookie.

    Requires a valid session (``require_auth`` is NOT exempt for this path)
    to prevent CSRF-based forced-logout attacks.
    """
    token = request.cookies.get(deps.SESSION_COOKIE)
    if token:
        await deps.db_client.delete_session(token)

    _clear_session_cookie(response)
    _log.info("Logout: session cleared")
    return {"authenticated": False}


# ---------------------------------------------------------------------------
# GET /api/auth/me
# ---------------------------------------------------------------------------

@router.get("/api/auth/me", response_model=AuthStatus)
async def me():
    """Return ``{authenticated: true}`` if the caller has a valid session.

    ``require_auth`` runs before this handler, so reaching here means the
    caller is already authenticated.  The UI polls this endpoint on every
    page load to detect expired sessions.
    """
    return AuthStatus(authenticated=True)


# ---------------------------------------------------------------------------
# PUT /api/auth/password
# ---------------------------------------------------------------------------

@router.put("/api/auth/password")
async def change_password(body: ChangePasswordRequest, request: Request, response: Response):
    """Change the instance password.

    Requires the caller to supply the current password for verification.
    On success:
    - Stores the new bcrypt hash.
    - Invalidates ALL existing sessions (forces re-login on all clients).
    - Clears the caller's own session cookie.

    The caller must log in again with the new password.
    """
    password_hash = await deps.db_client.get_password_hash()
    if not password_hash:
        raise HTTPException(status_code=401, detail="No credentials stored")

    if not _pwd_ctx.verify(body.current_password, password_hash):
        _log.warning("Change-password: incorrect current password")
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    new_hash = _pwd_ctx.hash(body.new_password)
    await deps.db_client.set_password_hash(new_hash)

    # Invalidate all sessions so every client must re-authenticate.
    await deps.db_client.delete_all_sessions()

    # Clear the caller's own cookie.
    _clear_session_cookie(response)

    _log.info("Password changed; all sessions invalidated")
    return {"detail": "Password updated. Please log in again."}


# ---------------------------------------------------------------------------
# POST /api/auth/mfa/setup
# ---------------------------------------------------------------------------

@router.post("/api/auth/mfa/setup", response_model=MfaSetupResponse)
async def mfa_setup():
    """Generate a new TOTP secret and return the QR code.

    Stores the secret in the DB but does NOT activate MFA yet — the caller
    must confirm a valid 6-digit code via ``POST /api/auth/mfa/verify-setup``
    to activate.

    Requires a valid session (``require_auth`` enforced).
    """
    secret = pyotp.random_base32()
    await deps.db_client.set_totp_secret(secret)

    totp = pyotp.TOTP(secret)
    otpauth_uri = totp.provisioning_uri(name="admin", issuer_name=_TOTP_ISSUER)

    # Generate QR code PNG and base64-encode it.
    img = qrcode.make(otpauth_uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    qr_b64 = base64.b64encode(buf.getvalue()).decode()

    _log.info("MFA setup: new TOTP secret generated")
    return MfaSetupResponse(secret=secret, otpauth_uri=otpauth_uri, qr_png_b64=qr_b64)


# ---------------------------------------------------------------------------
# POST /api/auth/mfa/verify-setup
# ---------------------------------------------------------------------------

@router.post("/api/auth/mfa/verify-setup")
async def mfa_verify_setup(body: MfaVerifyRequest):
    """Confirm the TOTP code and activate MFA.

    The caller must have previously called ``POST /api/auth/mfa/setup`` to
    generate a secret.  If the 6-digit code is valid, MFA is enabled.

    Requires a valid session (``require_auth`` enforced).
    """
    secret = await deps.db_client.get_totp_secret()
    if not secret:
        raise HTTPException(status_code=400, detail="No TOTP secret found — call /api/auth/mfa/setup first")

    totp = pyotp.TOTP(secret)
    if not totp.verify(body.code, valid_window=1):
        raise HTTPException(status_code=401, detail="Invalid TOTP code")

    await deps.db_client.set_mfa_enabled(True)
    _log.info("MFA enabled")
    return {"detail": "MFA enabled successfully"}


# ---------------------------------------------------------------------------
# POST /api/auth/mfa/challenge
# ---------------------------------------------------------------------------

@router.post("/api/auth/mfa/challenge")
async def mfa_challenge(body: MfaVerifyRequest, request: Request, response: Response):
    """Exchange a ferret_pending cookie + valid TOTP code for a full session.

    This endpoint is exempt from ``require_auth`` (it only requires the
    short-lived ``ferret_pending`` cookie, not a full session).

    On success:
    - Deletes the pending session from the DB.
    - Clears the ``ferret_pending`` cookie.
    - Issues a full ``ferret_session`` cookie.
    """
    pending_token = request.cookies.get(deps.PENDING_COOKIE)
    if not pending_token:
        raise HTTPException(status_code=401, detail="No pending session — please log in first")

    # Validate the pending session exists and has not expired.
    pending_key = f"pending:{pending_token}"
    session = await deps.db_client.get_session(pending_key)
    if not session:
        raise HTTPException(status_code=401, detail="Pending session not found or expired")

    now = datetime.now(timezone.utc).isoformat()
    if session["expires_at"] <= now:
        await deps.db_client.delete_session(pending_key)
        _clear_pending_cookie(response)
        raise HTTPException(status_code=401, detail="Pending session expired — please log in again")

    # Validate the TOTP code.
    secret = await deps.db_client.get_totp_secret()
    if not secret:
        raise HTTPException(status_code=500, detail="MFA secret not found")

    totp = pyotp.TOTP(secret)
    if not totp.verify(body.code, valid_window=1):
        raise HTTPException(status_code=401, detail="Invalid TOTP code")

    # Consume the pending session.
    await deps.db_client.delete_session(pending_key)
    _clear_pending_cookie(response)

    # Issue a full session.
    token = secrets.token_hex(32)
    expires_at = (datetime.now(timezone.utc) + deps.SESSION_TTL).isoformat()
    await deps.db_client.create_session(token, expires_at)
    _set_session_cookie(response, token)

    _log.info("MFA challenge passed — full session issued")
    return AuthStatus(authenticated=True, mfa_required=False, mfa_enabled=True)


# ---------------------------------------------------------------------------
# POST /api/auth/mfa/disable
# ---------------------------------------------------------------------------

@router.post("/api/auth/mfa/disable")
async def mfa_disable(body: MfaDisableRequest):
    """Disable MFA.

    Requires the current password AND a valid TOTP code to prevent an attacker
    with a stolen session from disabling MFA without knowing the password.

    On success:
    - Clears the TOTP secret.
    - Sets mfa_enabled = 0.
    - Does NOT invalidate existing sessions (the user is already authenticated).

    Requires a valid session (``require_auth`` enforced).
    """
    password_hash = await deps.db_client.get_password_hash()
    if not password_hash:
        raise HTTPException(status_code=401, detail="No credentials stored")

    if not _pwd_ctx.verify(body.current_password, password_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    secret = await deps.db_client.get_totp_secret()
    if not secret:
        raise HTTPException(status_code=400, detail="MFA is not enabled")

    totp = pyotp.TOTP(secret)
    if not totp.verify(body.code, valid_window=1):
        raise HTTPException(status_code=401, detail="Invalid TOTP code")

    await deps.db_client.set_mfa_enabled(False)
    _log.info("MFA disabled")
    return {"detail": "MFA disabled successfully"}


# ---------------------------------------------------------------------------
# GET /api/auth/mfa/status
# ---------------------------------------------------------------------------

@router.get("/api/auth/mfa/status")
async def mfa_status():
    """Return whether MFA is currently enabled.

    Requires a valid session (``require_auth`` enforced).
    """
    enabled = await deps.db_client.get_mfa_enabled()
    return {"mfa_enabled": enabled}

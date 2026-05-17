"""
Shared pytest fixtures for FERRET API v2 tests.

Strategy
--------
* The FastAPI app in main.py has a module-level ``db_client = SQLiteClient()``
  and a ``lifespan`` that starts mitmproxy.  We patch both so tests:
    - use an in-memory SQLite database (no /data directory needed)
    - never touch the real mitmproxy daemon
* Shared state lives in ``deps``; routers import from there.  We patch both
  ``deps`` and ``main`` so that both ``patch.object(main_module, ...)`` calls
  in individual tests AND the router code see the same mock objects.
* Each test gets a fresh AsyncClient via the ``client`` fixture, which also
  initialises and tears down the in-memory DB.
"""

import sys
import aiosqlite
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

# ---------------------------------------------------------------------------
# Make sure the api directory is on sys.path so that ``import main`` works
# when pytest is invoked from the repo root or from /app inside the container.
# ---------------------------------------------------------------------------
API_DIR = Path(__file__).parent
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

# Also add the routers sub-directory so that the split chats_* modules
# (chats_crud, chats_tools, chats_ai, chats_runners, chats_execute) can be
# imported by chats.py when tests load the app.
ROUTERS_DIR = API_DIR / "routers"
if str(ROUTERS_DIR) not in sys.path:
    sys.path.insert(0, str(ROUTERS_DIR))

from sqlite_client import SQLiteClient  # noqa: E402  (after sys.path tweak)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_mock_mitm_manager():
    """Return a MitmproxyManager mock that satisfies all async calls."""
    mgr = MagicMock()
    mgr.start = AsyncMock()
    mgr.stop = AsyncMock()
    mgr.get_status = AsyncMock(return_value={"running": False, "port": 1337})
    mgr.get_settings = AsyncMock(return_value={
        "listen_host": "0.0.0.0",
        "listen_port": 1337,
        "upstream_cert": True,
        "ssl_insecure": False,
        "http2": True,
        "websocket": True,
        "raw_tcp": False,
        "rawtcp_ports": [],
        "transparent": False,
        "mode": "regular",
    })
    mgr.update_settings = AsyncMock()
    mgr.get_snare_rules = AsyncMock(return_value=[])
    mgr.add_snare_rule = AsyncMock()
    mgr.delete_snare_rule = AsyncMock()
    mgr.start_snare = AsyncMock()
    mgr.stop_snare = AsyncMock()
    mgr.list_intercepted = AsyncMock(return_value=[])
    mgr.forward_intercepted = AsyncMock(return_value={"forwarded": True})
    mgr.drop_intercepted = AsyncMock(return_value=True)
    mgr.forward_response = AsyncMock(return_value=True)
    mgr.drop_response = AsyncMock(return_value=True)
    mgr.send_request = AsyncMock(return_value={})
    return mgr


async def _make_mem_db() -> SQLiteClient:
    """Create and initialise an in-memory SQLiteClient."""
    db = SQLiteClient.__new__(SQLiteClient)
    db.db_path = Path(":memory:")
    db._db = await aiosqlite.connect(":memory:")
    db._db.row_factory = aiosqlite.Row
    await db._db.execute("PRAGMA journal_mode=WAL")
    await db._db.execute("PRAGMA foreign_keys=ON")
    await db._create_schema()
    return db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def mem_db():
    """
    Yield an initialised SQLiteClient backed by an in-memory SQLite database.
    The connection is closed after the test.
    """
    db = await _make_mem_db()
    yield db
    await db.close()


# ---------------------------------------------------------------------------
# Shared no-op auth override (used by client and client_with_tests_dir)
# ---------------------------------------------------------------------------

async def _noop_require_auth():
    """FastAPI dependency override that bypasses authentication in tests."""
    return None


@pytest_asyncio.fixture
async def client(mem_db, tmp_path):
    """
    Yield an httpx.AsyncClient wired to the FERRET FastAPI app.

    Patches applied for every test:
    * ``deps.db_client``                → the in-memory SQLiteClient  (routers read from deps)
    * ``deps.mitm_manager``             → a fully-mocked MitmproxyManager
    * ``deps.TESTS_DIR``                → a temporary directory (empty by default)
    * ``app.dependency_overrides``      → require_auth bypassed (no-op)
    * ``main.db_client``                → same in-memory SQLiteClient  (backward compat)
    * ``main.mitm_manager``             → same mock manager            (backward compat)
    * ``main.TESTS_DIR``                → same tmp_path                (backward compat)
    * The app lifespan is replaced with a no-op so mitmproxy is never started.
    """
    import main as main_module
    import deps as deps_module

    mock_mgr = _make_mock_mitm_manager()

    @asynccontextmanager
    async def _noop_lifespan(app):
        yield

    original_lifespan = main_module.app.router.lifespan_context
    main_module.app.router.lifespan_context = _noop_lifespan

    # Override the require_auth dependency so all routes are accessible.
    main_module.app.dependency_overrides[deps_module.require_auth] = _noop_require_auth

    with (
        patch.object(deps_module, "db_client", mem_db),
        patch.object(deps_module, "mitm_manager", mock_mgr),
        patch.object(deps_module, "TESTS_DIR", tmp_path),
        patch.object(main_module, "db_client", mem_db),
        patch.object(main_module, "mitm_manager", mock_mgr),
        patch.object(main_module, "TESTS_DIR", tmp_path),
    ):
        transport = ASGITransport(app=main_module.app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac

    main_module.app.dependency_overrides.pop(deps_module.require_auth, None)
    main_module.app.router.lifespan_context = original_lifespan


@pytest_asyncio.fixture
async def client_with_tests_dir(mem_db, tmp_path):
    """
    Like ``client`` but also yields the tmp_path so tests can pre-populate
    TESTS_DIR with files before making requests.
    """
    import main as main_module
    import deps as deps_module

    mock_mgr = _make_mock_mitm_manager()

    @asynccontextmanager
    async def _noop_lifespan(app):
        yield

    original_lifespan = main_module.app.router.lifespan_context
    main_module.app.router.lifespan_context = _noop_lifespan

    main_module.app.dependency_overrides[deps_module.require_auth] = _noop_require_auth

    with (
        patch.object(deps_module, "db_client", mem_db),
        patch.object(deps_module, "mitm_manager", mock_mgr),
        patch.object(deps_module, "TESTS_DIR", tmp_path),
        patch.object(main_module, "db_client", mem_db),
        patch.object(main_module, "mitm_manager", mock_mgr),
        patch.object(main_module, "TESTS_DIR", tmp_path),
    ):
        transport = ASGITransport(app=main_module.app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac, tmp_path

    main_module.app.dependency_overrides.pop(deps_module.require_auth, None)
    main_module.app.router.lifespan_context = original_lifespan


# ---------------------------------------------------------------------------
# authed_client — real auth enforcement with pre-seeded credentials
# ---------------------------------------------------------------------------

_TEST_PASSWORD = "test-password-123"


@pytest_asyncio.fixture
async def authed_client(mem_db, tmp_path):
    """
    Yield an httpx.AsyncClient with real ``require_auth`` enforcement.

    Before yielding:
    - Seeds a bcrypt-hashed password into the in-memory DB.
    - Creates a valid session token and injects it as a cookie.
    - Does NOT override require_auth — the real dependency runs.

    Use this fixture for auth-specific tests that need to exercise the real
    authentication path (login, logout, session validation, Bearer tokens).
    """
    import main as main_module
    import deps as deps_module
    import secrets
    from datetime import datetime, timezone
    from passlib.context import CryptContext

    mock_mgr = _make_mock_mitm_manager()

    # Seed credentials
    pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
    password_hash = pwd_ctx.hash(_TEST_PASSWORD)
    await mem_db.set_password_hash(password_hash)

    # Seed a valid session
    session_token = secrets.token_hex(32)
    expires_at = (
        datetime.now(timezone.utc) + deps_module.SESSION_TTL
    ).isoformat()
    await mem_db.create_session(session_token, expires_at)

    @asynccontextmanager
    async def _noop_lifespan(app):
        yield

    original_lifespan = main_module.app.router.lifespan_context
    main_module.app.router.lifespan_context = _noop_lifespan

    # Ensure no leftover override from other fixtures.
    main_module.app.dependency_overrides.pop(deps_module.require_auth, None)

    with (
        patch.object(deps_module, "db_client", mem_db),
        patch.object(deps_module, "mitm_manager", mock_mgr),
        patch.object(deps_module, "TESTS_DIR", tmp_path),
        patch.object(main_module, "db_client", mem_db),
        patch.object(main_module, "mitm_manager", mock_mgr),
        patch.object(main_module, "TESTS_DIR", tmp_path),
    ):
        transport = ASGITransport(app=main_module.app)
        # Inject the session cookie so every request is authenticated.
        async with AsyncClient(
            transport=transport,
            base_url="http://test",
            cookies={deps_module.SESSION_COOKIE: session_token},
        ) as ac:
            # Expose test helpers on the client for convenience.
            ac._test_password = _TEST_PASSWORD          # type: ignore[attr-defined]
            ac._test_session_token = session_token      # type: ignore[attr-defined]
            ac._test_mem_db = mem_db                    # type: ignore[attr-defined]
            yield ac

    main_module.app.router.lifespan_context = original_lifespan


# ---------------------------------------------------------------------------
# unauthed_client — real auth enforcement, no pre-seeded session cookie
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def unauthed_client(mem_db, tmp_path):
    """
    Yield an httpx.AsyncClient with real ``require_auth`` enforcement but
    NO session cookie pre-injected.

    Use this fixture for auth tests that need to verify that requests without
    credentials are correctly rejected (401).  Unlike ``authed_client``, this
    client has credentials seeded in the DB (so login works) but does not
    carry a session cookie, so protected endpoints return 401.
    """
    import main as main_module
    import deps as deps_module
    from passlib.context import CryptContext

    mock_mgr = _make_mock_mitm_manager()

    # Seed credentials so login endpoint works, but don't inject a cookie.
    pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
    password_hash = pwd_ctx.hash("test-password-123")
    await mem_db.set_password_hash(password_hash)

    @asynccontextmanager
    async def _noop_lifespan(app):
        yield

    original_lifespan = main_module.app.router.lifespan_context
    main_module.app.router.lifespan_context = _noop_lifespan

    # Ensure no leftover override from other fixtures.
    main_module.app.dependency_overrides.pop(deps_module.require_auth, None)

    with (
        patch.object(deps_module, "db_client", mem_db),
        patch.object(deps_module, "mitm_manager", mock_mgr),
        patch.object(deps_module, "TESTS_DIR", tmp_path),
        patch.object(main_module, "db_client", mem_db),
        patch.object(main_module, "mitm_manager", mock_mgr),
        patch.object(main_module, "TESTS_DIR", tmp_path),
    ):
        transport = ASGITransport(app=main_module.app)
        async with AsyncClient(
            transport=transport,
            base_url="http://test",
            # No cookies — every request is unauthenticated by default.
        ) as ac:
            ac._test_mem_db = mem_db  # type: ignore[attr-defined]
            yield ac

    main_module.app.router.lifespan_context = original_lifespan

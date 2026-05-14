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


@pytest_asyncio.fixture
async def client(mem_db, tmp_path):
    """
    Yield an httpx.AsyncClient wired to the FERRET FastAPI app.

    Patches applied for every test:
    * ``deps.db_client``                → the in-memory SQLiteClient  (routers read from deps)
    * ``deps.mitm_manager``             → a fully-mocked MitmproxyManager
    * ``deps.TESTS_DIR``                → a temporary directory (empty by default)
    * ``deps.OPENROUTER_PROVISIONING_KEY`` → "" (prevents real OR key creation in tests)
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

    with (
        patch.object(deps_module, "db_client", mem_db),
        patch.object(deps_module, "mitm_manager", mock_mgr),
        patch.object(deps_module, "TESTS_DIR", tmp_path),
        patch.object(deps_module, "OPENROUTER_PROVISIONING_KEY", ""),
        patch.object(main_module, "db_client", mem_db),
        patch.object(main_module, "mitm_manager", mock_mgr),
        patch.object(main_module, "TESTS_DIR", tmp_path),
    ):
        transport = ASGITransport(app=main_module.app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac

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

    with (
        patch.object(deps_module, "db_client", mem_db),
        patch.object(deps_module, "mitm_manager", mock_mgr),
        patch.object(deps_module, "TESTS_DIR", tmp_path),
        patch.object(deps_module, "OPENROUTER_PROVISIONING_KEY", ""),
        patch.object(main_module, "db_client", mem_db),
        patch.object(main_module, "mitm_manager", mock_mgr),
        patch.object(main_module, "TESTS_DIR", tmp_path),
    ):
        transport = ASGITransport(app=main_module.app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac, tmp_path

    main_module.app.router.lifespan_context = original_lifespan

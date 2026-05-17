"""
FERRET - Forensic Analysis & Request Tracker
Main FastAPI application — thin app factory.

All shared state lives in ``deps``.
All route handlers live in ``routers/``.
"""

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path as _Path

# Add the routers/ directory to sys.path so that the split chats_* modules
# (chats_crud, chats_tools, chats_ai, chats_runners, chats_execute) can be
# imported by chats.py using bare module names.
_ROUTERS_DIR = _Path(__file__).parent / "routers"
if str(_ROUTERS_DIR) not in sys.path:
    sys.path.insert(0, str(_ROUTERS_DIR))

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.responses import Response
from pathlib import Path
from datetime import datetime
from typing import List

_log = logging.getLogger(__name__)

import deps
from routers import requests, proxy, findings, chats, tests, projects, settings, workspaces, setup, plans
from routers import auth as auth_router


# ---------------------------------------------------------------------------
# Re-export shared state so existing ``patch.object(main_module, ...)`` calls
# in tests continue to work.  The canonical source of truth is ``deps``.
# ---------------------------------------------------------------------------

db_client              = deps.db_client
mitm_manager           = deps.mitm_manager
OPENROUTER_MODEL       = deps.OPENROUTER_MODEL
TESTS_DIR              = deps.TESTS_DIR


# ---------------------------------------------------------------------------
# WebSocket connection manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: str):
        dead = []
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception:
                dead.append(connection)
        for c in dead:
            self.active_connections.remove(c)


ws_manager = ConnectionManager()
# Make ws_manager available to routers that need it (proxy start/stop)
deps.ws_manager = ws_manager  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Starting FERRET API...")
    await deps.db_client.initialize()
    await deps.db_client.seed_temp_project()
    # Load AI provider config from DB (setup wizard) — falls back to env vars
    await deps.reload_ai_config()
    loop = asyncio.get_running_loop()
    await deps.mitm_manager.start(db_client=deps.db_client, loop=loop, ws_manager=ws_manager)
    print("FERRET API started successfully")
    yield
    print("Shutting down FERRET API...")
    await deps.mitm_manager.stop()
    await deps.db_client.close()
    print("FERRET API shutdown complete")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="FERRET API",
    description="Forensic Analysis & Request Tracker - MITM Proxy Web Interface",
    version="1.0.0",
    lifespan=lifespan,
    dependencies=[Depends(deps.require_auth)],
)

_UI_PORT = os.getenv("UI_PORT", "3000")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"http://localhost:{_UI_PORT}",
        f"http://127.0.0.1:{_UI_PORT}",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Total-Count"],
)


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception) -> Response:
    _log.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers={
            "Access-Control-Allow-Origin": f"http://localhost:{_UI_PORT}",
            "Access-Control-Allow-Methods": "*",
            "Access-Control-Allow-Headers": "*",
        },
    )


@app.exception_handler(HTTPException)
async def _http_exception_handler(request: Request, exc: HTTPException) -> Response:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "*",
            "Access-Control-Allow-Headers": "*",
        },
    )


# ---------------------------------------------------------------------------
# Core endpoints
# ---------------------------------------------------------------------------

@app.get("/")
async def root():
    return {"message": "FERRET API - Forensic Analysis & Request Tracker"}


@app.get("/health")
async def health_check():
    proxy_status = await deps.mitm_manager.get_status()
    db_status = await deps.db_client.health_check()
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "services": {
            "proxy": proxy_status,
            "database": db_status,
        },
    }


# ---------------------------------------------------------------------------
# CA certificate download
# ---------------------------------------------------------------------------

_MITMPROXY_CONFDIR = Path(os.getenv("MITMPROXY_CONFDIR", "/data/mitmproxy"))
_CA_CERT_CANDIDATES = [
    # Persistent location in the db_data volume (survives container rebuilds)
    _MITMPROXY_CONFDIR / "mitmproxy-ca-cert.pem",
    _MITMPROXY_CONFDIR / "mitmproxy-ca-cert.cer",
    _MITMPROXY_CONFDIR / "mitmproxy-ca-cert.crt",
    # Fallback: default mitmproxy home (used if MITMPROXY_CONFDIR is not set)
    Path.home() / ".mitmproxy" / "mitmproxy-ca-cert.pem",
    Path.home() / ".mitmproxy" / "mitmproxy-ca-cert.cer",
    Path.home() / ".mitmproxy" / "mitmproxy-ca-cert.crt",
]


@app.get("/api/ca-cert")
async def download_ca_cert():
    """
    Serve the mitmproxy CA certificate so users can import it into their
    browser / OS trust store to avoid HTTPS warnings.
    """
    for candidate in _CA_CERT_CANDIDATES:
        if candidate.exists():
            return FileResponse(
                path=str(candidate),
                media_type="application/x-pem-file",
                filename="ferret-ca-cert.pem",
                headers={"Content-Disposition": 'attachment; filename="ferret-ca-cert.pem"'},
            )
    raise HTTPException(
        status_code=404,
        detail=(
            "CA certificate not found. Start the proxy at least once so mitmproxy "
            "can generate its certificate authority."
        ),
    )


# ---------------------------------------------------------------------------
# Include routers
# ---------------------------------------------------------------------------

app.include_router(auth_router.router)
app.include_router(setup.router)
app.include_router(requests.router)
app.include_router(proxy.router)
app.include_router(findings.router)
app.include_router(chats.router)
app.include_router(tests.router)
app.include_router(workspaces.router)
app.include_router(projects.router)
app.include_router(settings.router)
app.include_router(plans.router)


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

_WS_ALLOWED_ORIGINS = {
    f"http://localhost:{_UI_PORT}",
    f"http://127.0.0.1:{_UI_PORT}",
}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    origin = websocket.headers.get("origin", "")
    # Block connections from origins that are not the local UI.
    # Native WebSocket from the browser always sends an Origin header;
    # curl/wscat without --origin will have an empty string — allowed for
    # localhost developer tooling.
    if origin not in _WS_ALLOWED_ORIGINS:
        _log.warning("WebSocket rejected: disallowed origin %r", origin)
        await websocket.close(code=1008)  # 1008 = Policy Violation
        return
    await ws_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )

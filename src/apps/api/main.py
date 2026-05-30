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

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.responses import Response
from pathlib import Path
from datetime import datetime
from typing import List

# Configure logging level based on dev vs prod environment variables
_LOG_LEVEL_STR = os.getenv("FERRET_LOG_LEVEL", "").upper()
if not _LOG_LEVEL_STR:
    _LOG_LEVEL_STR = "DEBUG" if os.getenv("WATCHFILES_FORCE_POLLING") == "true" else "WARNING"

_LOG_LEVEL = getattr(logging, _LOG_LEVEL_STR, logging.WARNING)
logging.basicConfig(
    level=_LOG_LEVEL,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stderr)]
)

from services.workflow_logging import configure_unified_logging
configure_unified_logging()

_log = logging.getLogger(__name__)

import deps
from routers import requests, proxy, findings, tests, projects, settings, hunts, setup, plans, sources, runners, system_logs
from routers import auth as auth_router
from routers import chats, workspaces, runs


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
    # Start background scheduler for execution engine
    asyncio.create_task(deps.script_execution_engine.start_scheduler())
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
    _log.exception(
        "Unhandled exception on %s %s", 
        request.method, 
        request.url.path,
        extra={"details": "An unhandled exception was captured by the FastAPI global exception handler. The server returned a 500 Internal Server Error."}
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers={
            "Access-Control-Allow-Origin": f"http://localhost:{_UI_PORT}",
            "Access-Control-Allow-Methods": "*",
            "Access-Control-Allow-Headers": "*",
        },
    )


from fastapi.exceptions import RequestValidationError

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> Response:
    body_str = ""
    if hasattr(request, "_body"):
        body_str = request._body.decode(errors='replace')
    elif exc.body is not None:
        body_str = str(exc.body)
    print(f"VALIDATION ERROR on {request.method} {request.url.path}: {exc.errors()}", flush=True)
    print(f"REQUEST HEADERS: {dict(request.headers)}", flush=True)
    print(f"REQUEST BODY: {body_str}", flush=True)
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors(), "body": str(exc.body)},
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


@app.get("/api/tools")
async def list_tools():
    """Return the name, human-readable label, and group of every AI tool available in session chat."""
    from routers.chats_tools import SESSION_CHAT_TOOLS
    return [
        {
            "name": t["function"]["name"],
            "label": t["function"].get("label", t["function"]["name"]),
            "group": t["function"].get("group"),
        }
        for t in SESSION_CHAT_TOOLS
    ]


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
app.include_router(hunts.router)
app.include_router(projects.router)
app.include_router(settings.router)
app.include_router(plans.router)
app.include_router(sources.router)
app.include_router(workspaces.router)
app.include_router(runs.router)
app.include_router(runners.router)
app.include_router(system_logs.router)


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
        _log.warning(
            "WebSocket rejected: disallowed origin %r", 
            origin,
            extra={"details": "An incoming WebSocket connection request was blocked because its origin header does not match the allowed client ports (local UI)."}
        )
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

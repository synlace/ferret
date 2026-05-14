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
# OpenRouter AI config
# ---------------------------------------------------------------------------

# OPENROUTER_PROVISIONING_KEY is the master account key used *only* to
# create/delete/inspect provisioned sub-keys via the OR management API.
# Chat and annotation calls use the per-project provisioned key stored in the DB.
OPENROUTER_PROVISIONING_KEY = os.getenv("OPENROUTER_PROVISIONING_KEY", "")
OPENROUTER_MODEL             = os.getenv("OPENROUTER_MODEL", "google/gemini-3-flash-preview")


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


def provisioning_headers() -> dict:
    """Build Authorization headers using the master provisioning key."""
    return openrouter_headers(OPENROUTER_PROVISIONING_KEY)


async def get_key_for_project(project_id: str) -> Optional[str]:
    """Return the provisioned key value for a project, or None if none exists.

    All AI calls (chat, annotate, findings) require a provisioned key to be
    stored in the DB for the project.  There is no global fallback key.
    """
    return await db_client.get_active_key_for_project(project_id)


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
    """Run pytest on *test_path* inside the ferret-lab sandbox container."""
    proc = await asyncio.create_subprocess_exec(
        "docker", "exec", SANDBOX_CONTAINER,
        "python3", "-m", "pytest", str(test_path),
        "--tb=short", "-v", "--no-header",
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

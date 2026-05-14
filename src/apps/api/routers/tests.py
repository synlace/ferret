"""
Test file management and test run endpoints.
"""

import asyncio
import httpx
import os
import uuid
from datetime import datetime
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Any, Dict, List, Optional

import deps
from models import TestRun, TestRunRequest

router = APIRouter()


class TestFileWrite(BaseModel):
    content: str


@router.get("/api/tests/files")
async def list_test_files(project_id: str = "temp"):
    """List all test files grouped by host."""
    try:
        if not deps.TESTS_DIR.exists():
            return {"files": []}
        files = []
        search_dirs = [deps.TESTS_DIR / project_id, deps.TESTS_DIR]
        seen: set = set()
        for search_dir in search_dirs:
            if not search_dir.exists():
                continue
            for p in sorted(search_dir.glob("test_*.py")):
                if p.name in seen:
                    continue
                seen.add(p.name)
                stem = p.stem
                host_part = stem[len("test_"):] if stem.startswith("test_") else stem
                host = host_part.replace("_", ".")
                files.append({
                    "filename": p.name,
                    "host": host,
                    "size": p.stat().st_size,
                    "project_id": project_id,
                })
        return {"files": files}
    except Exception as e:
        raise deps.server_error(e)


def _safe_test_path(filename: str) -> Path:
    """Resolve *filename* under TESTS_DIR and raise 400 if it escapes the root."""
    resolved = (deps.TESTS_DIR / filename).resolve()
    try:
        resolved.relative_to(deps.TESTS_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Path traversal not allowed")
    return resolved


@router.get("/api/tests/files/{filename:path}")
async def get_test_file(filename: str):
    """Read the source of a test file."""
    try:
        path = _safe_test_path(filename)
        if not path.exists() or not path.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        return {"filename": filename, "content": path.read_text()}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.put("/api/tests/files/{filename:path}")
async def write_test_file(filename: str, body: TestFileWrite):
    """Write/update a test file."""
    try:
        path = _safe_test_path(filename)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body.content)
        return {"filename": filename, "size": path.stat().st_size}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/tests/run")
async def run_tests(body: TestRunRequest):
    """Run a test file (or single test) and stream output via SSE."""
    run_id = str(uuid.uuid4())
    test_path = deps.TESTS_DIR / body.file

    if not test_path.exists():
        raise HTTPException(status_code=404, detail="Test file not found")

    cmd = ["docker", "exec"]
    if body.via_proxy:
        proxy_addr = "http://api:1337"
        cmd += ["-e", f"HTTP_PROXY={proxy_addr}", "-e", f"HTTPS_PROXY={proxy_addr}", "-e", "FERRET_SOURCE=test"]
    cmd += [deps.SANDBOX_CONTAINER, "python3", "-m", "pytest", "-v", "--tb=short"]
    if body.test_name:
        cmd.append(f"{test_path}::{body.test_name}")
    else:
        cmd.append(str(test_path))

    async def event_stream():
        run = TestRun(
            id=run_id,
            file=body.file,
            test_name=body.test_name,
            via_proxy=body.via_proxy,
            status="running",
            started_at=datetime.utcnow(),
        )
        await deps.db_client.store_test_run(run)

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        output_lines = []
        yield f"data: {{\"run_id\": \"{run_id}\", \"status\": \"running\"}}\n\n"

        assert proc.stdout is not None
        async for line in proc.stdout:
            text = line.decode("utf-8", errors="replace").rstrip()
            output_lines.append(text)
            escaped = text.replace("\\", "\\\\").replace('"', '\\"')
            yield f"data: {{\"line\": \"{escaped}\"}}\n\n"

        await proc.wait()
        exit_code = proc.returncode
        final_status = "passed" if exit_code == 0 else "failed"
        full_output = "\n".join(output_lines)

        await deps.db_client.update_test_run(
            run_id, final_status, full_output, datetime.utcnow()
        )
        yield f"data: {{\"run_id\": \"{run_id}\", \"status\": \"{final_status}\", \"exit_code\": {exit_code}}}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/api/tests/runs")
async def get_test_runs(file: Optional[str] = None, limit: int = 50, project_id: str = "temp"):
    """List recent test runs."""
    try:
        return await deps.db_client.get_test_runs(file=file, limit=limit, project_id=project_id)
    except Exception as e:
        raise deps.server_error(e)


# ---------------------------------------------------------------------------
# Tests chat — AI assistant for test files
# ---------------------------------------------------------------------------

class TestChatRequest(BaseModel):
    message: str
    context: Optional[Dict[str, Any]] = None
    project_id: str = "temp"
    model: Optional[str] = None


@router.post("/api/tests/chat")
async def tests_chat(body: TestChatRequest):
    """Send a message to the AI with optional test-file context.

    Returns {"reply": "..."}.
    """
    api_key = await deps.get_key_for_project(body.project_id)
    if not api_key:
        raise HTTPException(503, f"No provisioned key for project '{body.project_id}'. Add one via Projects → Keys.")

    model = body.model or deps.OPENROUTER_MODEL

    system_prompt = (
        "You are a security testing assistant embedded in a proxy tool called FERRET. "
        "Help the user write, debug, and improve pytest security tests. "
        "Format your responses using Markdown — use code blocks for code, "
        "bullet lists for findings, and bold for important terms."
    )

    messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]

    # Inject file context if provided
    if body.context:
        ctx_parts = []
        if body.context.get("file"):
            ctx_parts.append(f"Current test file: {body.context['file']}")
        if body.context.get("source"):
            ctx_parts.append(f"File source:\n```python\n{body.context['source']}\n```")
        if ctx_parts:
            messages.append({"role": "system", "content": "\n\n".join(ctx_parts)})

    messages.append({"role": "user", "content": body.message})

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=deps.openrouter_headers(api_key),
                json={"model": model, "messages": messages},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"OpenRouter {e.response.status_code}: {e.response.text[:200]}")
    except Exception as e:
        raise HTTPException(502, f"OpenRouter failed: {e}")

    reply = data["choices"][0]["message"].get("content") or ""
    return {"reply": reply}

"""
Tool call executor — dispatches a single tool call to the appropriate handler.
"""

import uuid
import json
import logging
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

import httpx

import deps
from chats_runners import stream_run_script, stream_run_ffuf, stream_run_katana
from proxy import _assert_safe_url

_log = logging.getLogger(__name__)


async def execute_tool_call(
    tc: Dict[str, Any],
    project_id: str = "temp",
    session_id: str = "",
    recent_tool_outputs: Optional[List[str]] = None,
) -> str:
    """Execute a single tool call and return the result string.

    ``recent_tool_outputs`` is an optional list of tool result strings from the
    current agentic loop iteration.  It is used by the ``create_finding`` handler
    to detect evidence that was not actually produced by any tool in this session
    (i.e. hallucinated evidence).
    """
    fn_name = tc["function"]["name"]
    try:
        fn_args = json.loads(tc["function"].get("arguments", "{}"))
    except json.JSONDecodeError:
        fn_args = {}

    if fn_name in ("write_pytest_file", "write_test"):
        filename = fn_args.get("filename", "test_generated.py")
        code = deps.strip_fences(fn_args.get("code", ""))
        # Sanitise filename — no path traversal
        filename = filename.replace("/", "_").replace("..", "_")
        if not filename.endswith(".py"):
            filename += ".py"
        # Write into the workspace tests/ subdir when called from a session so
        # the file appears in the workspace file tree immediately.  Fall back to
        # the legacy TESTS_DIR for non-workspace callers (backwards compat).
        if session_id:
            test_path = deps.WORKSPACES_DIR / project_id / session_id / "tests" / filename
        else:
            test_path = deps.TESTS_DIR / filename
        try:
            test_path.parent.mkdir(parents=True, exist_ok=True)
            test_path.write_text(code, encoding="utf-8")
            result = await deps.run_pytest(test_path)
        except Exception as exc:
            result = f"[FERRET] Error writing/running test ({type(exc).__name__}): {exc}\n  test_path={test_path}"
        return result

    elif fn_name in ("run_pytest_file", "run_test"):
        filename = fn_args.get("filename", "")
        filename = filename.replace("/", "_").replace("..", "_")
        if not filename.endswith(".py"):
            filename += ".py"
        # Prefer workspace path when session context is available
        if session_id:
            test_path = deps.WORKSPACES_DIR / project_id / session_id / "tests" / filename
        else:
            test_path = deps.TESTS_DIR / filename
        if test_path.exists():
            return await deps.run_pytest(test_path)
        return f"[FERRET] Test file '{filename}' not found. Use write_test first."

    elif fn_name in ("read_pytest_file", "read_test"):
        filename = fn_args.get("filename", "")
        filename = filename.replace("/", "_").replace("..", "_")
        if not filename.endswith(".py"):
            filename += ".py"
        # Prefer workspace path when session context is available
        if session_id:
            test_path = deps.WORKSPACES_DIR / project_id / session_id / "tests" / filename
        else:
            test_path = deps.TESTS_DIR / filename
        if test_path.exists():
            return test_path.read_text(encoding="utf-8")
        return f"[FERRET] Test file '{filename}' not found. Use write_test to create it first."

    elif fn_name == "pip_install":
        import re as _re
        import asyncio as _asyncio
        packages = fn_args.get("packages", [])
        if not packages:
            return "[FERRET] No packages specified."
        safe_packages = [p for p in packages if _re.match(r'^[a-zA-Z0-9_\-\[\]>=<.,]+$', p)]
        if not safe_packages:
            return "[FERRET] No valid package names provided."
        try:
            proc = await _asyncio.create_subprocess_exec(
                "docker", "exec", deps.SANDBOX_CONTAINER,
                "pip3", "install", "--quiet", "--break-system-packages", *safe_packages,
                stdout=_asyncio.subprocess.PIPE,
                stderr=_asyncio.subprocess.STDOUT,
            )
            stdout, _ = await proc.communicate()
            output = stdout.decode("utf-8", errors="replace").strip()
            if proc.returncode == 0:
                return f"[FERRET] Installed: {', '.join(safe_packages)}\n{output}"
            return f"[FERRET] pip install failed (exit {proc.returncode}):\n{output}"
        except Exception as exc:
            return f"[FERRET] pip install error: {exc}"

    elif fn_name == "search_requests":
        query = fn_args.get("query", "").strip()
        limit = int(fn_args.get("limit", 20))
        try:
            # Pass the query through unchanged — the DB layer (_search_uses_like)
            # detects dots, slashes, colons and other FTS5-hostile characters and
            # routes them through LIKE on url/host/path instead of FTS5 MATCH.
            use_search = query if query else None

            # search_requests returns List[HttpRequest], not a tuple
            results = await deps.db_client.search_requests(
                search=use_search, limit=limit, project_id=project_id
            )
            if not results:
                return f"[FERRET] No requests found matching '{query}'."
            lines = []
            for r in results:
                lines.append(f"  {r.id}  {r.method} {r.url} [{r.status_code}]")
            text = "\n".join(lines)
            import json as _json
            structured = [
                {
                    "id": str(r.id),
                    "method": str(r.method).replace("HttpMethod.", ""),
                    "url": r.url,
                    "host": r.host,
                    "path": r.path,
                    "status_code": r.status_code,
                    "response_time": r.response_time,
                    "response_size": len(r.response_body.encode("utf-8")) if r.response_body else None,
                }
                for r in results
            ]
            return text + "\n__JSON__:" + _json.dumps(structured)
        except Exception as exc:
            return f"[FERRET] Search error: {exc}"

    elif fn_name == "get_request_detail":
        request_id = fn_args.get("request_id", "").strip()
        if not request_id:
            return "[FERRET] request_id is required."
        try:
            req = await deps.db_client.get_request(request_id)
            if req is None:
                return f"[FERRET] Request '{request_id}' not found."
            parts = [
                f"ID: {req.id}",
                f"Method: {req.method}  URL: {req.url}",
                f"Status: {req.status_code}",
                f"Host: {req.host}",
            ]
            if req.headers:
                parts.append("Request Headers:\n" + "\n".join(f"  {k}: {v}" for k, v in req.headers.items()))
            if req.body:
                parts.append(f"Request Body:\n{req.body[:2000]}")
            if req.response_headers:
                parts.append("Response Headers:\n" + "\n".join(f"  {k}: {v}" for k, v in req.response_headers.items()))
            if req.response_body:
                parts.append(f"Response Body:\n{req.response_body[:3000]}")
            text = "\n\n".join(parts)
            import json as _json
            structured = {
                "id": str(req.id),
                "method": str(req.method).replace("HttpMethod.", ""),
                "url": req.url,
                "host": req.host,
                "status_code": req.status_code,
                "headers": dict(req.headers) if req.headers else {},
                "body": req.body,
                "response_headers": dict(req.response_headers) if req.response_headers else {},
                "response_body": req.response_body,
            }
            return text + "\n__JSON__:" + _json.dumps(structured)
        except Exception as exc:
            return f"[FERRET] Error fetching request: {exc}"

    elif fn_name == "create_finding":
        from models import Finding

        # ── Evidence hallucination guard ────────────────────────────────────
        # Check whether the evidence field contains phrases that look like
        # confirmed outcomes (e.g. "Lab Solved!", "Checkout status: 302") but
        # were NOT actually present in any tool output from this session.
        # If suspicious phrases are found, log a warning and annotate the
        # finding so reviewers know the evidence may be fabricated.
        evidence = fn_args.get("evidence") or ""
        _SUSPICIOUS_OUTCOME_PHRASES = [
            "Lab Solved",
            "Congratulations",
            "Checkout status: 302",
            "Purchase confirmed",
            "Successfully purchased",
            "successfully solving the lab",
        ]
        _tool_outputs = recent_tool_outputs or []
        _hallucinated_phrases = [
            phrase for phrase in _SUSPICIOUS_OUTCOME_PHRASES
            if phrase.lower() in evidence.lower()
            and not any(phrase.lower() in out.lower() for out in _tool_outputs)
        ]
        if _hallucinated_phrases:
            _log.warning(
                "[chat] create_finding: evidence contains outcome phrase(s) %s "
                "not found in any tool output — possible hallucination. "
                "session_id=%s title=%r",
                _hallucinated_phrases,
                session_id,
                fn_args.get("title", ""),
            )
            evidence = (
                evidence
                + "\n\n[FERRET WARNING] The following phrase(s) in this evidence "
                "were NOT confirmed by any tool output in this session and may be "
                f"hallucinated: {_hallucinated_phrases}"
            )
            fn_args = {**fn_args, "evidence": evidence}
        # ── End evidence guard ───────────────────────────────────────────────

        try:
            finding = Finding(
                id=str(uuid.uuid4()),
                title=fn_args.get("title", "Untitled Finding"),
                severity=fn_args.get("severity", "info"),
                type=fn_args.get("type", "other"),
                host=fn_args.get("host", ""),
                description=fn_args.get("description"),
                evidence=fn_args.get("evidence"),
                request_id=fn_args.get("request_id"),
                source="ai",
                status="open",
                created_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
            await deps.db_client.store_finding(finding, project_id=project_id)
            parts = [
                f"[FERRET] Finding created: id={finding.id}",
                f"  Title: {finding.title}",
                f"  Severity: {finding.severity}",
                f"  Host: {finding.host}",
            ]
            if finding.description:
                parts.append(f"  Description: {finding.description}")
            if finding.evidence:
                parts.append(f"  Evidence: {finding.evidence}")
            return "\n".join(parts)
        except Exception as exc:
            return f"[FERRET] Error creating finding: {exc}"

    elif fn_name == "list_findings":
        try:
            severity = fn_args.get("severity")
            status = fn_args.get("status")
            findings = await deps.db_client.get_findings(
                severity=severity, status=status, project_id=project_id
            )
            if not findings:
                return "[FERRET] No findings found for this project."
            lines = []
            for f in findings:
                lines.append(
                    f"  [{f.get('severity','?').upper()}] {f.get('title','?')} "
                    f"(id={f.get('id','?')}, status={f.get('status','?')}, host={f.get('host','?')})"
                )
            return "\n".join(lines)
        except Exception as exc:
            return f"[FERRET] Error listing findings: {exc}"

    elif fn_name == "run_script":
        # Delegate to the streaming generator; collect all output for non-streaming callers
        chunks: List[str] = []
        final: str = ""
        async for _chunk, _is_final, _result in stream_run_script(fn_args, project_id=project_id, session_id=session_id):
            if _is_final:
                final = _result or ""
            else:
                chunks.append(_chunk)
        return final if final else "".join(chunks)

    elif fn_name == "run_katana":
        # Delegate to the streaming generator; collect all output for non-streaming callers
        chunks: List[str] = []
        final: str = ""
        async for _chunk, _is_final, _result in stream_run_katana(fn_args):
            if _is_final:
                final = _result or ""
            else:
                chunks.append(_chunk)
        return final if final else "".join(chunks)

    elif fn_name == "run_ffuf":
        # Delegate to the streaming generator; collect all output for non-streaming callers
        chunks: List[str] = []
        final: str = ""
        async for _chunk, _is_final, _result in stream_run_ffuf(fn_args):
            if _is_final:
                final = _result or ""
            else:
                chunks.append(_chunk)
        return final if final else "".join(chunks)

    elif fn_name == "http_request":
        method = fn_args.get("method", "GET").upper()
        url = fn_args.get("url", "").strip()
        if not url:
            return "[FERRET] url is required."
        req_headers: Dict[str, Any] = dict(fn_args.get("headers") or {})
        body = fn_args.get("body") or None
        content_type = fn_args.get("content_type")
        via_proxy = fn_args.get("via_proxy", True)
        timeout = int(fn_args.get("timeout") or 15)

        if content_type:
            req_headers["Content-Type"] = content_type

        proxy_url = "http://127.0.0.1:1337" if via_proxy else None
        proxies = {"http://": proxy_url, "https://": proxy_url} if proxy_url else {}

        try:
            _assert_safe_url(url)
            async with httpx.AsyncClient(
                verify=False,
                proxies=proxies,
                timeout=float(timeout),
                follow_redirects=False,
            ) as client:
                resp = await client.request(
                    method,
                    url,
                    headers=req_headers,
                    content=body.encode() if body else None,
                )

            body_text = resp.text
            body_preview = body_text[:3000]
            if len(body_text) > 3000:
                body_preview += f"\n... ({len(body_text) - 3000} bytes truncated)"

            elapsed_ms = int(resp.elapsed.total_seconds() * 1000) if resp.elapsed else 0

            import json as _json
            return _json.dumps({
                "status_code": resp.status_code,
                "elapsed_ms": elapsed_ms,
                "response_headers": dict(resp.headers),
                "response_body": body_preview,
            })
        except httpx.TimeoutException:
            return f"[FERRET] Request timed out after {timeout}s — possible blind injection if intentional."
        except Exception as exc:
            return f"[FERRET] HTTP request failed: {exc}"

    return f"[FERRET] Unknown tool: {fn_name}"

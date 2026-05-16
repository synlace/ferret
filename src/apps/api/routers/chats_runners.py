"""
Streaming subprocess helpers for run_script, run_ffuf, and run_katana.

Each async generator yields tuples of (chunk: str, is_final: bool, final_result: str | None).
While is_final is False, chunk is a raw output chunk to stream to the client.
When is_final is True, final_result is the complete result string (with __META__).
"""

from typing import List, Dict, Any

import deps

# ---------------------------------------------------------------------------
# Persistent session preamble injected at the top of every python3 run_script.
#
# Problem: each run_script call spawns a fresh Python process, so
# requests.Session() objects — and their cookies — are lost between calls.
# This causes multi-step exploits (e.g. overflow cart → checkout) to fail
# because the second script starts with an empty, unauthenticated session.
#
# Solution: inject a preamble that loads a pickled requests.Session from a
# per-chat-session file in /tmp inside the sandbox container.  The session is
# saved back to disk via atexit so it persists across run_script calls.
# The model is instructed (in the system prompt) to use the pre-built `session`
# variable rather than creating a new one.
# ---------------------------------------------------------------------------

_PYTHON_SESSION_PREAMBLE_TEMPLATE = """\
# [FERRET] Persistent session preamble — do not remove
import os as _ferret_os, pickle as _ferret_pickle, atexit as _ferret_atexit
import requests as _ferret_requests
import urllib3 as _ferret_urllib3
_ferret_urllib3.disable_warnings(_ferret_urllib3.exceptions.InsecureRequestWarning)
_FERRET_SESSION_FILE = "/tmp/ferret_session_{safe_session_id}.pkl"
if _ferret_os.path.exists(_FERRET_SESSION_FILE):
    try:
        with open(_FERRET_SESSION_FILE, "rb") as _f:
            session = _ferret_pickle.load(_f)
    except Exception:
        session = _ferret_requests.Session()
        session.verify = False
else:
    session = _ferret_requests.Session()
    session.verify = False
def _ferret_save_session():
    try:
        with open(_FERRET_SESSION_FILE, "wb") as _f:
            _ferret_pickle.dump(session, _f)
    except Exception:
        pass
_ferret_atexit.register(_ferret_save_session)
# [FERRET] End preamble — your script follows
"""


async def stream_run_script(fn_args: Dict[str, Any], project_id: str = "temp", session_id: str = ""):
    """Async generator: stream run_script output line-by-line, then yield final result."""
    import asyncio as _asyncio
    import tempfile as _tempfile
    import os as _os
    import json as _json
    import time as _time

    interpreter = fn_args.get("interpreter", "bash")
    if interpreter not in ("bash", "python3"):
        yield ("[FERRET] interpreter must be 'bash' or 'python3'.", True, "[FERRET] interpreter must be 'bash' or 'python3'.")
        return
    script = fn_args.get("script", "").strip()
    if not script:
        yield ("[FERRET] script is required.", True, "[FERRET] script is required.")
        return
    timeout_sec = min(int(fn_args.get("timeout") or 30), 120)
    ext = ".sh" if interpreter == "bash" else ".py"

    # For Python scripts running inside a session context, prepend the persistent
    # session preamble so that cookies/auth survive across multiple run_script calls.
    if interpreter == "python3" and session_id:
        import re as _re
        # Sanitise session_id to a safe filename component (alphanumeric + hyphen only)
        safe_sid = _re.sub(r"[^a-zA-Z0-9\-]", "_", session_id)[:64]
        preamble = _PYTHON_SESSION_PREAMBLE_TEMPLATE.format(safe_session_id=safe_sid)
        # Strip any existing `session = requests.Session()` lines the model wrote
        # so the preamble's persistent session is not immediately overwritten.
        script = _re.sub(
            r"^\s*session\s*=\s*requests\.Session\(\).*$",
            "# [FERRET] session replaced by persistent preamble session",
            script,
            flags=_re.MULTILINE,
        )
        script = preamble + script

    # Persist the script to the workspace scripts/ subdir so it appears in the
    # file tree.  Only done when called from a session context (session_id set).
    if session_id:
        import datetime as _dt
        ts_slug = _dt.datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        script_name = f"script_{ts_slug}{ext}"
        ws_script_path = deps.WORKSPACES_DIR / project_id / session_id / "scripts" / script_name
        try:
            ws_script_path.parent.mkdir(parents=True, exist_ok=True)
            ws_script_path.write_text(script, encoding="utf-8")
        except Exception:
            pass  # non-fatal — execution continues even if persist fails

    try:
        with _tempfile.NamedTemporaryFile(mode="w", suffix=ext, delete=False, encoding="utf-8") as tf:
            tf.write(script)
            tmp_path = tf.name
        container_path = f"/tmp/ferret_script_{_os.path.basename(tmp_path)}"
        cp_proc = await _asyncio.create_subprocess_exec(
            "docker", "cp", tmp_path, f"{deps.SANDBOX_CONTAINER}:{container_path}",
            stdout=_asyncio.subprocess.PIPE, stderr=_asyncio.subprocess.STDOUT,
        )
        await cp_proc.communicate()
        _os.unlink(tmp_path)
        if cp_proc.returncode != 0:
            msg = "[FERRET] Failed to copy script into sandbox."
            yield (msg, True, msg)
            return
        exec_proc = await _asyncio.create_subprocess_exec(
            "docker", "exec", deps.SANDBOX_CONTAINER,
            interpreter, container_path,
            stdout=_asyncio.subprocess.PIPE,
            stderr=_asyncio.subprocess.STDOUT,
        )
        _t0 = _time.monotonic()
        all_chunks: List[str] = []
        total_bytes = 0
        MAX_BYTES = 8192
        timed_out = False
        try:
            async def _read_lines():
                nonlocal total_bytes, timed_out
                assert exec_proc.stdout is not None
                while True:
                    try:
                        line = await _asyncio.wait_for(exec_proc.stdout.readline(), timeout=timeout_sec)
                    except _asyncio.TimeoutError:
                        timed_out = True
                        exec_proc.kill()
                        break
                    if not line:
                        break
                    chunk = line.decode("utf-8", errors="replace")
                    total_bytes += len(chunk)
                    if total_bytes > MAX_BYTES:
                        all_chunks.append("\n... [truncated]")
                        exec_proc.kill()
                        break
                    all_chunks.append(chunk)
                    yield chunk
            async for chunk in _read_lines():
                yield (chunk, False, None)
        except Exception:
            pass
        await exec_proc.wait()
        rc = exec_proc.returncode
        _runtime_ms = round((_time.monotonic() - _t0) * 1000)
        _ts = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%d %H:%M")
        if timed_out:
            timeout_msg = f"\r\n[FERRET] Script timed out after {timeout_sec}s.\r\n"
            yield (timeout_msg, False, None)
            all_chunks.append(timeout_msg)
        full_output = "".join(all_chunks)
        prefix = f"[exit {rc}]\r\n" if rc not in (0, None) else ""
        text = prefix + full_output if full_output.strip() else f"[exit {rc}] (no output)"
        final = text + "\n__META__:" + _json.dumps({"exit_code": rc, "runtime_ms": _runtime_ms, "timestamp": _ts})
        yield ("", True, final)
    except Exception as exc:
        msg = f"[FERRET] run_script error: {exc}"
        yield (msg, True, msg)


async def stream_run_ffuf(fn_args: Dict[str, Any]):
    """Async generator: stream run_ffuf output line-by-line, then yield final result."""
    import asyncio as _asyncio
    import shlex as _shlex
    import json as _json
    import time as _time

    url = fn_args.get("url", "").strip()
    if not url:
        msg = "[FERRET] url is required."
        yield (msg, True, msg); return
    if "FUZZ" not in url and not fn_args.get("data", "") and not fn_args.get("extra_args", ""):
        msg = "[FERRET] url must contain the FUZZ keyword (or supply data/extra_args with FUZZ)."
        yield (msg, True, msg); return
    wordlist = fn_args.get("wordlist", "/usr/share/dirb/wordlists/common.txt").strip()
    method = fn_args.get("method", "GET").upper()
    headers: Dict[str, Any] = dict(fn_args.get("headers") or {})
    data = fn_args.get("data", "").strip()
    match_codes = fn_args.get("match_codes", "200,204,301,302,307,401,403,405,500").strip()
    filter_codes = fn_args.get("filter_codes", "").strip()
    filter_size = fn_args.get("filter_size", "").strip()
    threads = min(int(fn_args.get("threads") or 40), 100)
    timeout_sec = min(int(fn_args.get("timeout") or 60), 300)
    extra_args = fn_args.get("extra_args", "").strip()

    cmd: List[str] = [
        "ffuf", "-u", url, "-w", wordlist, "-X", method,
        "-t", str(threads), "-mc", match_codes, "-timeout", "10",
        "-noninteractive",
    ]
    if filter_codes: cmd += ["-fc", filter_codes]
    if filter_size: cmd += ["-fs", filter_size]
    if data: cmd += ["-d", data]
    for hk, hv in headers.items(): cmd += ["-H", f"{hk}: {hv}"]
    if extra_args:
        try: cmd += _shlex.split(extra_args)
        except ValueError: pass

    try:
        exec_proc = await _asyncio.create_subprocess_exec(
            "docker", "exec", deps.SANDBOX_CONTAINER, *cmd,
            stdout=_asyncio.subprocess.PIPE,
            stderr=_asyncio.subprocess.STDOUT,
        )
        _t0 = _time.monotonic()
        all_chunks: List[str] = []
        total_bytes = 0
        MAX_BYTES = 16384
        timed_out = False
        try:
            async def _read_lines():
                nonlocal total_bytes, timed_out
                assert exec_proc.stdout is not None
                while True:
                    try:
                        line = await _asyncio.wait_for(exec_proc.stdout.readline(), timeout=timeout_sec)
                    except _asyncio.TimeoutError:
                        timed_out = True
                        exec_proc.kill()
                        break
                    if not line:
                        break
                    chunk = line.decode("utf-8", errors="replace")
                    total_bytes += len(chunk)
                    if total_bytes > MAX_BYTES:
                        all_chunks.append("\r\n... [truncated]\r\n")
                        exec_proc.kill()
                        break
                    # Filter ffuf progress lines — they're carriage-return noise in the UI
                    if chunk.startswith(":: Progress:") or (":: Job [" in chunk and ":: Duration:" in chunk):
                        all_chunks.append(chunk)
                        continue
                    all_chunks.append(chunk)
                    yield chunk
            async for chunk in _read_lines():
                yield (chunk, False, None)
        except Exception:
            pass
        await exec_proc.wait()
        rc = exec_proc.returncode
        _runtime_ms = round((_time.monotonic() - _t0) * 1000)
        _ts = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%d %H:%M")
        if timed_out:
            timeout_msg = f"\r\n[FERRET] ffuf timed out after {timeout_sec}s.\r\n"
            yield (timeout_msg, False, None)
            all_chunks.append(timeout_msg)
        full_output = "".join(all_chunks)
        prefix = f"[exit {rc}]\r\n" if rc not in (0, None) else ""
        text = prefix + full_output if full_output.strip() else f"[exit {rc}] (no output — no matches found)"
        final = text + "\n__META__:" + _json.dumps({"exit_code": rc, "runtime_ms": _runtime_ms, "timestamp": _ts})
        yield ("", True, final)
    except Exception as exc:
        msg = f"[FERRET] run_ffuf error: {exc}"
        yield (msg, True, msg)


async def stream_run_katana(fn_args: Dict[str, Any]):
    """Async generator: stream katana web-crawler output line-by-line, then yield final result."""
    import asyncio as _asyncio
    import shlex as _shlex
    import json as _json
    import time as _time

    url = fn_args.get("url", "").strip()
    if not url:
        msg = "[FERRET] url is required."
        yield (msg, True, msg); return

    depth = min(int(fn_args.get("depth") or 3), 10)
    js_crawl = fn_args.get("js_crawl", True)
    headless = fn_args.get("headless", False)
    scope = fn_args.get("scope", "").strip()
    proxy = fn_args.get("proxy", "http://api:1337").strip()
    timeout_sec = min(int(fn_args.get("timeout") or 60), 300)
    extra_args = fn_args.get("extra_args", "").strip()

    cmd: List[str] = [
        "katana",
        "-u", url,
        "-depth", str(depth),
        "-silent",
        "-no-color",
    ]
    if js_crawl:
        cmd.append("-js-crawl")
    if headless:
        cmd.append("-headless")
    if scope:
        cmd += ["-field-scope", scope]
    if proxy:
        cmd += ["-proxy", proxy]
    if extra_args:
        try:
            cmd += _shlex.split(extra_args)
        except ValueError:
            pass

    try:
        exec_proc = await _asyncio.create_subprocess_exec(
            "docker", "exec", deps.SANDBOX_CONTAINER, *cmd,
            stdout=_asyncio.subprocess.PIPE,
            stderr=_asyncio.subprocess.STDOUT,
        )
        _t0 = _time.monotonic()
        all_chunks: List[str] = []
        total_bytes = 0
        MAX_BYTES = 16384
        timed_out = False
        try:
            async def _read_lines():
                nonlocal total_bytes, timed_out
                assert exec_proc.stdout is not None
                while True:
                    try:
                        line = await _asyncio.wait_for(exec_proc.stdout.readline(), timeout=timeout_sec)
                    except _asyncio.TimeoutError:
                        timed_out = True
                        exec_proc.kill()
                        break
                    if not line:
                        break
                    chunk = line.decode("utf-8", errors="replace")
                    total_bytes += len(chunk)
                    if total_bytes > MAX_BYTES:
                        all_chunks.append("\r\n... [truncated]\r\n")
                        exec_proc.kill()
                        break
                    all_chunks.append(chunk)
                    yield chunk
            async for chunk in _read_lines():
                yield (chunk, False, None)
        except Exception:
            pass
        await exec_proc.wait()
        rc = exec_proc.returncode
        _runtime_ms = round((_time.monotonic() - _t0) * 1000)
        _ts = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%d %H:%M")
        if timed_out:
            timeout_msg = f"\r\n[FERRET] katana timed out after {timeout_sec}s.\r\n"
            yield (timeout_msg, False, None)
            all_chunks.append(timeout_msg)
        full_output = "".join(all_chunks)
        prefix = f"[exit {rc}]\r\n" if rc not in (0, None) else ""
        text = prefix + full_output if full_output.strip() else f"[exit {rc}] (no output — no URLs discovered)"
        final = text + "\n__META__:" + _json.dumps({"exit_code": rc, "runtime_ms": _runtime_ms, "timestamp": _ts})
        yield ("", True, final)
    except Exception as exc:
        msg = f"[FERRET] run_katana error: {exc}"
        yield (msg, True, msg)

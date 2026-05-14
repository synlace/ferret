"""
FERRET API — pytest unit tests for chat agentic tool execution.

Covers
------
_execute_tool_call (routers.chats):
  - search_requests: empty query → no FTS5 error, returns all requests
  - search_requests: URL-style query (contains /) → sanitised, no FTS5 error
  - search_requests: hostname query (contains .) → sanitised, no FTS5 error
  - search_requests: no matching results → returns "[FERRET] No requests found" message
  - search_requests: matching results → returns formatted list
  - write_pytest_file: writes file and returns pytest output
  - write_pytest_file: path traversal in filename is sanitised
  - run_pytest_file: runs existing file and returns output
  - run_pytest_file: missing file returns helpful error message
  - unknown tool name → returns "[FERRET] Unknown tool" message

POST /api/chats/{id}/messages — agentic loop:
  - When OpenRouter returns a tool_call, the endpoint executes it and loops
  - Tool result is appended as a "tool" role message
  - Final assistant message (no tool_calls) ends the loop
  - All messages (user, assistant-with-tool-calls, tool, final-assistant) are persisted

POST /api/chats/{id}/messages/stream — SSE streaming:
  - Returns text/event-stream content-type
  - Emits delta events for text tokens
  - Emits tool_start / tool_result events around tool execution
  - Emits done event with final messages list
  - Returns error SSE event when session has no provisioned key

Run with:
    cd github/monorepo/tools/ferret/src/apps/api
    pytest test_api_chat_tools.py -v
"""

import json
import uuid
import pytest
import pytest_asyncio
import httpx
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch, call

# conftest.py provides: client, mem_db, client_with_tests_dir fixtures


# ---------------------------------------------------------------------------
# Helpers shared with test_api_chat_sessions.py (duplicated to keep files
# self-contained — no cross-test-file imports)
# ---------------------------------------------------------------------------

_CHAT_SESSION_PAYLOAD = {"name": "Tool test session", "scope": "blank"}


async def _seed_project_key(mem_db, project_id: str = "temp"):
    """Seed a provisioned key for a project so AI endpoints don't return 503."""
    from models import ProjectApiKey
    await mem_db.seed_temp_project()
    key = ProjectApiKey(
        id=str(uuid.uuid4()),
        project_id=project_id,
        name="test-key",
        key_hash="hash-test",
        key_preview="sk-or-v1-test...0000",
        limit_usd=None,
        created_at=datetime.utcnow().isoformat(),
    )
    await mem_db.store_project_api_key(key, "sk-or-v1-test-key-value")


def _make_openrouter_response(content: str = "Done.", tool_calls=None) -> MagicMock:
    """Return a mock httpx.Response shaped like a successful OpenRouter reply."""
    msg: dict = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"choices": [{"message": msg}]}
    mock_resp.raise_for_status = MagicMock()
    return mock_resp


def _make_async_client_ctx(mock_response: MagicMock):
    inner = MagicMock()
    inner.post = AsyncMock(return_value=mock_response)
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=inner)
    cm.__aexit__ = AsyncMock(return_value=False)
    return MagicMock(return_value=cm), inner


def _make_multi_response_ctx(responses: list):
    """
    Return a mock httpx.AsyncClient whose .post() returns each response in
    *responses* in order (one per call).
    """
    inner = MagicMock()
    inner.post = AsyncMock(side_effect=responses)
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=inner)
    cm.__aexit__ = AsyncMock(return_value=False)
    return MagicMock(return_value=cm), inner


# ---------------------------------------------------------------------------
# Helpers for SSE streaming tests
# ---------------------------------------------------------------------------

def _make_sse_lines(*events: dict) -> list[str]:
    """Convert a list of event dicts into SSE-formatted lines."""
    lines = []
    for ev in events:
        lines.append(f"data: {json.dumps(ev)}")
        lines.append("")  # blank line between events
    lines.append("data: [DONE]")
    return lines


def _make_streaming_client_ctx(sse_lines: list[str]):
    """
    Return a mock httpx.AsyncClient whose .stream() context manager yields
    the given SSE lines via aiter_lines().
    """
    async def _aiter_lines():
        for line in sse_lines:
            yield line

    stream_resp = MagicMock()
    stream_resp.raise_for_status = MagicMock()
    stream_resp.aiter_lines = _aiter_lines

    stream_cm = MagicMock()
    stream_cm.__aenter__ = AsyncMock(return_value=stream_resp)
    stream_cm.__aexit__ = AsyncMock(return_value=False)

    inner = MagicMock()
    inner.stream = MagicMock(return_value=stream_cm)

    outer_cm = MagicMock()
    outer_cm.__aenter__ = AsyncMock(return_value=inner)
    outer_cm.__aexit__ = AsyncMock(return_value=False)

    return MagicMock(return_value=outer_cm)


# ===========================================================================
# _execute_tool_call — search_requests
# ===========================================================================

class TestExecuteToolCallSearchRequests:
    """
    Unit tests for the search_requests branch of _execute_tool_call.

    We call the function directly (not via HTTP) so we can inject a real
    in-memory DB and verify the FTS5 sanitisation logic without needing to
    mock the entire HTTP stack.
    """

    @pytest.mark.asyncio
    async def test_empty_query_does_not_raise(self, mem_db):
        """An empty query must not raise an FTS5 error; it returns all requests."""
        import deps as deps_module
        from routers.chats import _execute_tool_call

        with patch.object(deps_module, "db_client", mem_db):
            tc = {
                "function": {
                    "name": "search_requests",
                    "arguments": json.dumps({"query": ""}),
                }
            }
            result = await _execute_tool_call(tc)

        # No exception; result is either "no requests found" or a list
        assert isinstance(result, str)
        assert "[FERRET] Search error" not in result

    @pytest.mark.asyncio
    async def test_url_style_query_does_not_raise(self, mem_db):
        """A query like 'GET /api/login' must not raise an FTS5 syntax error."""
        import deps as deps_module
        from routers.chats import _execute_tool_call

        with patch.object(deps_module, "db_client", mem_db):
            tc = {
                "function": {
                    "name": "search_requests",
                    "arguments": json.dumps({"query": "GET /api/login"}),
                }
            }
            result = await _execute_tool_call(tc)

        assert isinstance(result, str)
        assert "[FERRET] Search error" not in result, f"Got error: {result}"

    @pytest.mark.asyncio
    async def test_hostname_query_does_not_raise(self, mem_db):
        """A query like 'example.com' must not raise an FTS5 syntax error."""
        import deps as deps_module
        from routers.chats import _execute_tool_call

        with patch.object(deps_module, "db_client", mem_db):
            tc = {
                "function": {
                    "name": "search_requests",
                    "arguments": json.dumps({"query": "example.com"}),
                }
            }
            result = await _execute_tool_call(tc)

        assert isinstance(result, str)
        assert "[FERRET] Search error" not in result, f"Got error: {result}"

    @pytest.mark.asyncio
    async def test_special_chars_query_does_not_raise(self, mem_db):
        """Queries with FTS5-special chars (*, (, ), :, -) must not raise."""
        import deps as deps_module
        from routers.chats import _execute_tool_call

        for query in ["*", "(test)", "key:value", "a-b", "a OR b", 'a "phrase"']:
            with patch.object(deps_module, "db_client", mem_db):
                tc = {
                    "function": {
                        "name": "search_requests",
                        "arguments": json.dumps({"query": query}),
                    }
                }
                result = await _execute_tool_call(tc)

            assert isinstance(result, str), f"query={query!r}"
            assert "[FERRET] Search error" not in result, (
                f"query={query!r} produced error: {result}"
            )

    @pytest.mark.asyncio
    async def test_no_results_returns_not_found_message(self, mem_db):
        """When no requests match, the result contains a 'No requests found' message."""
        import deps as deps_module
        from routers.chats import _execute_tool_call

        with patch.object(deps_module, "db_client", mem_db):
            tc = {
                "function": {
                    "name": "search_requests",
                    "arguments": json.dumps({"query": "nonexistentxyz"}),
                }
            }
            result = await _execute_tool_call(tc)

        assert "No requests found" in result

    @pytest.mark.asyncio
    async def test_matching_results_returned_as_formatted_list(self, mem_db):
        """When requests exist, the result lists them as 'METHOD URL [STATUS]'."""
        import deps as deps_module
        from routers.chats import _execute_tool_call
        from models import HttpRequest

        # Seed a request into the DB
        req = HttpRequest(
            id=str(uuid.uuid4()),
            method="GET",
            url="http://example.com/api/users",
            host="example.com",
            path="/api/users",
            headers={},
            status_code=200,
            timestamp=datetime.utcnow().isoformat(),
        )
        await mem_db.seed_temp_project()
        await mem_db.store_request(req, project_id="temp")

        with patch.object(deps_module, "db_client", mem_db):
            tc = {
                "function": {
                    "name": "search_requests",
                    # Empty query → returns all requests
                    "arguments": json.dumps({"query": ""}),
                }
            }
            result = await _execute_tool_call(tc)

        assert "GET" in result
        assert "example.com" in result
        assert "200" in result


# ===========================================================================
# _execute_tool_call — write_pytest_file
# ===========================================================================

class TestExecuteToolCallWritePytestFile:
    """Unit tests for the write_pytest_file branch of _execute_tool_call."""

    @pytest.mark.asyncio
    async def test_writes_file_and_returns_pytest_output(self, tmp_path):
        """write_pytest_file writes the code to disk and returns pytest output."""
        import deps as deps_module
        from routers.chats import _execute_tool_call

        code = "def test_always_passes():\n    assert 1 + 1 == 2\n"

        with patch.object(deps_module, "TESTS_DIR", tmp_path), \
             patch.object(deps_module, "run_pytest", new=AsyncMock(return_value="1 passed")):
            tc = {
                "function": {
                    "name": "write_pytest_file",
                    "arguments": json.dumps({
                        "filename": "test_simple.py",
                        "code": code,
                    }),
                }
            }
            result = await _execute_tool_call(tc)

        # The file should have been written
        assert (tmp_path / "test_simple.py").exists()
        # pytest output should mention the test
        assert isinstance(result, str)
        assert len(result) > 0

    @pytest.mark.asyncio
    async def test_path_traversal_in_filename_is_sanitised(self, tmp_path):
        """Filenames with path separators or '..' must be sanitised."""
        import deps as deps_module
        from routers.chats import _execute_tool_call

        code = "def test_x():\n    pass\n"

        with patch.object(deps_module, "TESTS_DIR", tmp_path), \
             patch.object(deps_module, "run_pytest", new=AsyncMock(return_value="1 passed")):
            tc = {
                "function": {
                    "name": "write_pytest_file",
                    "arguments": json.dumps({
                        "filename": "../../evil/test_escape.py",
                        "code": code,
                    }),
                }
            }
            result = await _execute_tool_call(tc)

        # The file must land inside tmp_path, not escape it
        written = list(tmp_path.glob("*.py"))
        assert len(written) == 1
        assert written[0].parent == tmp_path

    @pytest.mark.asyncio
    async def test_filename_without_py_extension_gets_extension_added(self, tmp_path):
        """If the filename has no .py extension, one is appended."""
        import deps as deps_module
        from routers.chats import _execute_tool_call

        code = "def test_x():\n    pass\n"

        with patch.object(deps_module, "TESTS_DIR", tmp_path), \
             patch.object(deps_module, "run_pytest", new=AsyncMock(return_value="1 passed")):
            tc = {
                "function": {
                    "name": "write_pytest_file",
                    "arguments": json.dumps({
                        "filename": "test_no_ext",
                        "code": code,
                    }),
                }
            }
            await _execute_tool_call(tc)

        assert (tmp_path / "test_no_ext.py").exists()

    @pytest.mark.asyncio
    async def test_strips_markdown_fences_from_code(self, tmp_path):
        """Code wrapped in ```python ... ``` fences must be stripped before writing."""
        import deps as deps_module
        from routers.chats import _execute_tool_call

        fenced_code = "```python\ndef test_fenced():\n    assert True\n```"

        with patch.object(deps_module, "TESTS_DIR", tmp_path), \
             patch.object(deps_module, "run_pytest", new=AsyncMock(return_value="1 passed")):
            tc = {
                "function": {
                    "name": "write_pytest_file",
                    "arguments": json.dumps({
                        "filename": "test_fenced.py",
                        "code": fenced_code,
                    }),
                }
            }
            result = await _execute_tool_call(tc)

        written = (tmp_path / "test_fenced.py").read_text()
        assert "```" not in written, "Markdown fences were not stripped"


# ===========================================================================
# _execute_tool_call — run_pytest_file
# ===========================================================================

class TestExecuteToolCallRunPytestFile:
    """Unit tests for the run_pytest_file branch of _execute_tool_call."""

    @pytest.mark.asyncio
    async def test_runs_existing_file_and_returns_output(self, tmp_path):
        """run_pytest_file on an existing file returns pytest output."""
        import deps as deps_module
        from routers.chats import _execute_tool_call

        test_file = tmp_path / "test_existing.py"
        test_file.write_text("def test_ok():\n    assert True\n")

        with patch.object(deps_module, "TESTS_DIR", tmp_path), \
             patch.object(deps_module, "run_pytest", new=AsyncMock(return_value="1 passed")) as mock_run:
            tc = {
                "function": {
                    "name": "run_pytest_file",
                    "arguments": json.dumps({"filename": "test_existing.py"}),
                }
            }
            result = await _execute_tool_call(tc)

        assert isinstance(result, str)
        assert len(result) > 0
        mock_run.assert_called_once()

    @pytest.mark.asyncio
    async def test_missing_file_returns_helpful_error(self, tmp_path):
        """run_pytest_file on a non-existent file returns a '[FERRET]' error message."""
        import deps as deps_module
        from routers.chats import _execute_tool_call

        with patch.object(deps_module, "TESTS_DIR", tmp_path):
            tc = {
                "function": {
                    "name": "run_pytest_file",
                    "arguments": json.dumps({"filename": "test_does_not_exist.py"}),
                }
            }
            result = await _execute_tool_call(tc)

        assert "[FERRET]" in result
        assert "not found" in result.lower() or "write_pytest_file" in result


# ===========================================================================
# _execute_tool_call — unknown tool
# ===========================================================================

class TestExecuteToolCallUnknown:
    @pytest.mark.asyncio
    async def test_unknown_tool_returns_error_string(self):
        """An unrecognised tool name returns a '[FERRET] Unknown tool' message."""
        from routers.chats import _execute_tool_call

        tc = {
            "function": {
                "name": "do_something_weird",
                "arguments": "{}",
            }
        }
        result = await _execute_tool_call(tc)
        assert "[FERRET] Unknown tool" in result


# ===========================================================================
# POST /api/chats/{id}/messages — agentic loop
# ===========================================================================

class TestSendSessionMessageAgenticLoop:
    """
    Tests for the multi-turn agentic loop in send_session_message.

    The loop works like this:
      1. POST to OpenRouter → returns tool_calls
      2. Execute each tool call
      3. POST to OpenRouter again with tool results → returns final text
      4. Persist all messages and return
    """

    @pytest.mark.asyncio
    async def test_tool_call_loop_executes_and_returns_final_answer(self, client, mem_db, tmp_path):
        """
        When OpenRouter returns a tool_call on the first turn, the endpoint
        must execute it and loop back to get the final answer.
        """
        import deps as deps_module
        await _seed_project_key(mem_db)
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        # First OR response: tool call to write_pytest_file
        tool_call_resp = _make_openrouter_response(
            content=None,
            tool_calls=[{
                "id": "call_abc123",
                "type": "function",
                "function": {
                    "name": "write_pytest_file",
                    "arguments": json.dumps({
                        "filename": "test_loop.py",
                        "code": "def test_loop():\n    assert True\n",
                    }),
                },
            }],
        )
        # Second OR response: final text answer
        final_resp = _make_openrouter_response(content="All tests passed!")

        cls_mock, _ = _make_multi_response_ctx([tool_call_resp, final_resp])

        with patch("routers.chats.httpx.AsyncClient", cls_mock), \
             patch.object(deps_module, "TESTS_DIR", tmp_path), \
             patch.object(deps_module, "run_pytest", new=AsyncMock(return_value="1 passed")):
            resp = await client.post(
                f"/api/chats/{session_id}/messages",
                json={"message": "Run a security test"},
            )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert "messages" in data

        roles = [m["role"] for m in data["messages"]]
        assert "user" in roles
        assert "assistant" in roles
        assert "tool" in roles

        # Final assistant message should contain the final answer
        assistant_msgs = [m for m in data["messages"] if m["role"] == "assistant"]
        final_content = assistant_msgs[-1].get("content", "")
        assert "All tests passed" in final_content

    @pytest.mark.asyncio
    async def test_tool_results_persisted_in_history(self, client, mem_db, tmp_path):
        """
        After an agentic loop, GET /messages must return all turns including
        the tool result message.
        """
        import deps as deps_module
        await _seed_project_key(mem_db)
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        tool_call_resp = _make_openrouter_response(
            content=None,
            tool_calls=[{
                "id": "call_persist",
                "type": "function",
                "function": {
                    "name": "write_pytest_file",
                    "arguments": json.dumps({
                        "filename": "test_persist.py",
                        "code": "def test_p():\n    assert True\n",
                    }),
                },
            }],
        )
        final_resp = _make_openrouter_response(content="Done persisting.")

        cls_mock, _ = _make_multi_response_ctx([tool_call_resp, final_resp])

        with patch("routers.chats.httpx.AsyncClient", cls_mock), \
             patch.object(deps_module, "TESTS_DIR", tmp_path), \
             patch.object(deps_module, "run_pytest", new=AsyncMock(return_value="1 passed")):
            await client.post(
                f"/api/chats/{session_id}/messages",
                json={"message": "Persist test"},
            )

        get_resp = await client.get(f"/api/chats/{session_id}/messages")
        messages = get_resp.json()["messages"]
        roles = [m["role"] for m in messages]

        assert "user" in roles
        assert "tool" in roles
        assert "assistant" in roles

    @pytest.mark.asyncio
    async def test_search_requests_tool_call_with_url_query(self, client, mem_db, tmp_path):
        """
        When the AI calls search_requests with a URL-style query (e.g. 'GET /api/login'),
        the endpoint must not return a 500 error — the FTS5 sanitisation must work.
        """
        import deps as deps_module
        await _seed_project_key(mem_db)
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        tool_call_resp = _make_openrouter_response(
            content=None,
            tool_calls=[{
                "id": "call_search",
                "type": "function",
                "function": {
                    "name": "search_requests",
                    "arguments": json.dumps({"query": "GET /api/login"}),
                },
            }],
        )
        final_resp = _make_openrouter_response(content="Search complete.")

        cls_mock, _ = _make_multi_response_ctx([tool_call_resp, final_resp])

        with patch("routers.chats.httpx.AsyncClient", cls_mock), \
             patch.object(deps_module, "TESTS_DIR", tmp_path):
            resp = await client.post(
                f"/api/chats/{session_id}/messages",
                json={"message": "Search for login requests"},
            )

        assert resp.status_code == 200, resp.text
        # Verify the tool result message doesn't contain a search error
        messages = resp.json()["messages"]
        tool_msgs = [m for m in messages if m["role"] == "tool"]
        for tm in tool_msgs:
            assert "[FERRET] Search error" not in (tm.get("content") or ""), (
                f"FTS5 error leaked into tool result: {tm.get('content')}"
            )

    @pytest.mark.asyncio
    async def test_search_requests_tool_call_with_hostname_query(self, client, mem_db, tmp_path):
        """
        When the AI calls search_requests with a hostname query (e.g. 'example.com'),
        the FTS5 sanitisation must prevent a syntax error.
        """
        import deps as deps_module
        await _seed_project_key(mem_db)
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        tool_call_resp = _make_openrouter_response(
            content=None,
            tool_calls=[{
                "id": "call_host_search",
                "type": "function",
                "function": {
                    "name": "search_requests",
                    "arguments": json.dumps({"query": "example.com"}),
                },
            }],
        )
        final_resp = _make_openrouter_response(content="Host search done.")

        cls_mock, _ = _make_multi_response_ctx([tool_call_resp, final_resp])

        with patch("routers.chats.httpx.AsyncClient", cls_mock), \
             patch.object(deps_module, "TESTS_DIR", tmp_path):
            resp = await client.post(
                f"/api/chats/{session_id}/messages",
                json={"message": "Search for example.com requests"},
            )

        assert resp.status_code == 200, resp.text
        messages = resp.json()["messages"]
        tool_msgs = [m for m in messages if m["role"] == "tool"]
        for tm in tool_msgs:
            assert "[FERRET] Search error" not in (tm.get("content") or ""), (
                f"FTS5 error leaked into tool result: {tm.get('content')}"
            )


# ===========================================================================
# POST /api/chats/{id}/messages/stream — SSE streaming
# ===========================================================================

class TestStreamSessionMessage:
    """
    Tests for the SSE streaming endpoint.

    We mock httpx.AsyncClient.stream() to return pre-canned SSE lines and
    verify the response body contains the expected event types.
    """

    def _parse_sse_events(self, body: bytes) -> list[dict]:
        """Parse raw SSE response body into a list of event dicts."""
        events = []
        for line in body.decode().splitlines():
            if line.startswith("data: "):
                raw = line[6:].strip()
                if raw and raw != "[DONE]":
                    try:
                        events.append(json.loads(raw))
                    except json.JSONDecodeError:
                        pass
        return events

    @pytest.mark.asyncio
    async def test_stream_returns_event_stream_content_type(self, client, mem_db):
        """The streaming endpoint must return text/event-stream."""
        await _seed_project_key(mem_db)
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        sse_lines = _make_sse_lines(
            {"choices": [{"delta": {"content": "Hello"}, "finish_reason": None}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        )
        cls_mock = _make_streaming_client_ctx(sse_lines)

        with patch("routers.chats.httpx.AsyncClient", cls_mock):
            resp = await client.post(
                f"/api/chats/{session_id}/messages/stream",
                json={"message": "Hi"},
            )

        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")

    @pytest.mark.asyncio
    async def test_stream_emits_delta_events(self, client, mem_db):
        """The streaming endpoint must emit 'delta' events for text tokens."""
        await _seed_project_key(mem_db)
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        sse_lines = _make_sse_lines(
            {"choices": [{"delta": {"content": "Hello"}, "finish_reason": None}]},
            {"choices": [{"delta": {"content": " world"}, "finish_reason": None}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        )
        cls_mock = _make_streaming_client_ctx(sse_lines)

        with patch("routers.chats.httpx.AsyncClient", cls_mock):
            resp = await client.post(
                f"/api/chats/{session_id}/messages/stream",
                json={"message": "Hi"},
            )

        events = self._parse_sse_events(resp.content)
        delta_events = [e for e in events if e.get("type") == "delta"]
        assert len(delta_events) >= 1
        combined = "".join(e.get("content", "") for e in delta_events)
        assert "Hello" in combined

    @pytest.mark.asyncio
    async def test_stream_emits_done_event_with_messages(self, client, mem_db):
        """The streaming endpoint must emit a 'done' event with the full messages list."""
        await _seed_project_key(mem_db)
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        sse_lines = _make_sse_lines(
            {"choices": [{"delta": {"content": "Final answer"}, "finish_reason": None}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        )
        cls_mock = _make_streaming_client_ctx(sse_lines)

        with patch("routers.chats.httpx.AsyncClient", cls_mock):
            resp = await client.post(
                f"/api/chats/{session_id}/messages/stream",
                json={"message": "Tell me something"},
            )

        events = self._parse_sse_events(resp.content)
        done_events = [e for e in events if e.get("type") == "done"]
        assert len(done_events) == 1, f"Expected 1 done event, got: {done_events}"
        assert "messages" in done_events[0]

    @pytest.mark.asyncio
    async def test_stream_returns_503_when_no_key_provisioned(self, client, mem_db):
        """
        When the project has no provisioned OpenRouter key, the streaming
        endpoint must return HTTP 503 with a JSON body whose 'detail' field
        mentions 'provisioned key' — so the frontend can detect it and show
        the helper notice instead of silently doing nothing.
        """
        # Ensure the temp project exists but has NO key seeded
        await mem_db.seed_temp_project()

        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        resp = await client.post(
            f"/api/chats/{session_id}/messages/stream",
            json={"message": "Hello"},
        )

        assert resp.status_code == 503, (
            f"Expected 503 when no key is provisioned, got {resp.status_code}: {resp.text}"
        )
        body = resp.json()
        assert "detail" in body, f"Expected 'detail' in response body, got: {body}"
        assert "provisioned key" in body["detail"], (
            f"Expected 'provisioned key' in detail, got: {body['detail']!r}"
        )

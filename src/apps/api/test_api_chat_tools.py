"""
FERRET API — pytest unit tests for chat tool execution.

Covers
------
execute_tool_call (routers.chats_execute):
  - search_requests: empty query → no FTS5 error, returns all requests
  - search_requests: URL-style query (contains /) → sanitised, no FTS5 error
  - search_requests: hostname query (contains .) → sanitised, no FTS5 error
  - search_requests: no matching results → returns "[FERRET] No requests found" message
  - search_requests: matching results → returns formatted list
  - write_test: writes file and returns pytest output
  - write_test: path traversal in filename is sanitised
  - run_test: runs existing file and returns output
  - run_test: missing file returns helpful error message
  - unknown tool name → returns "[FERRET] Unknown tool" message
  - list_sources: project dir missing → returns "No sources found" message
  - list_sources: project dir empty → returns "No sources found" message
  - list_sources: files present → returns formatted list with filenames and sizes
  - read_source: empty filename → returns "filename is required" message
  - read_source: file not found → returns "not found. Use list_sources" message
  - read_source: file exists → returns header + content
  - read_source: path traversal in filename → stripped to basename, resolved safely

GET /api/tools:
  - Returns a non-empty list of {name, label} objects
  - Contains all expected tool names
  - Every tool has a non-empty label

resolve_tools (routers.chats_tools):
  - None → returns full SESSION_CHAT_TOOLS list
  - [] → returns empty list (all tools disabled)
  - ['search_requests'] → returns only that tool
  - unknown names → silently ignored

Run with:
    cd github/ferret/src/apps/api
    pytest test_api_chat_tools.py -v
"""

import json
import uuid
import pytest
import pytest_asyncio
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# conftest.py provides: client, mem_db, client_with_tests_dir fixtures


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_CHAT_SESSION_PAYLOAD = {"name": "Tool test session", "scope": "blank"}


def _make_tc(name: str, **kwargs) -> dict:
    """Build a minimal tool-call dict for execute_tool_call."""
    return {"function": {"name": name, "arguments": json.dumps(kwargs)}}


# ===========================================================================
# execute_tool_call — search_requests
# ===========================================================================

class TestExecuteToolCallSearchRequests:
    """
    Unit tests for the search_requests branch of execute_tool_call.

    We call the function directly (not via HTTP) so we can inject a real
    in-memory DB and verify the FTS5 sanitisation logic without needing to
    mock the entire HTTP stack.
    """

    @pytest.mark.asyncio
    async def test_empty_query_does_not_raise(self, mem_db):
        """An empty query must not raise an FTS5 error; it returns all requests."""
        import deps as deps_module
        from routers.chats_execute import execute_tool_call

        with patch.object(deps_module, "db_client", mem_db):
            tc = {
                "function": {
                    "name": "search_requests",
                    "arguments": json.dumps({"query": "", "rationale": "test"}),
                }
            }
            result = await execute_tool_call(tc)

        assert isinstance(result, str)
        assert "[FERRET] Search error" not in result

    @pytest.mark.asyncio
    async def test_url_style_query_does_not_raise(self, mem_db):
        """A query like 'GET /api/login' must not raise an FTS5 syntax error."""
        import deps as deps_module
        from routers.chats_execute import execute_tool_call

        with patch.object(deps_module, "db_client", mem_db):
            tc = {
                "function": {
                    "name": "search_requests",
                    "arguments": json.dumps({"query": "GET /api/login", "rationale": "test"}),
                }
            }
            result = await execute_tool_call(tc)

        assert isinstance(result, str)
        assert "[FERRET] Search error" not in result, f"Got error: {result}"

    @pytest.mark.asyncio
    async def test_hostname_query_does_not_raise(self, mem_db):
        """A query like 'example.com' must not raise an FTS5 syntax error."""
        import deps as deps_module
        from routers.chats_execute import execute_tool_call

        with patch.object(deps_module, "db_client", mem_db):
            tc = {
                "function": {
                    "name": "search_requests",
                    "arguments": json.dumps({"query": "example.com", "rationale": "test"}),
                }
            }
            result = await execute_tool_call(tc)

        assert isinstance(result, str)
        assert "[FERRET] Search error" not in result, f"Got error: {result}"

    @pytest.mark.asyncio
    async def test_special_chars_query_does_not_raise(self, mem_db):
        """Queries with FTS5-special chars (*, (, ), :, -) must not raise."""
        import deps as deps_module
        from routers.chats_execute import execute_tool_call

        for query in ["*", "(test)", "key:value", "a-b", "a OR b", 'a "phrase"']:
            with patch.object(deps_module, "db_client", mem_db):
                tc = {
                    "function": {
                        "name": "search_requests",
                        "arguments": json.dumps({"query": query, "rationale": "test"}),
                    }
                }
                result = await execute_tool_call(tc)

            assert isinstance(result, str), f"query={query!r}"
            assert "[FERRET] Search error" not in result, (
                f"query={query!r} produced error: {result}"
            )

    @pytest.mark.asyncio
    async def test_no_results_returns_not_found_message(self, mem_db):
        """When no requests match, the result contains a 'No requests found' message."""
        import deps as deps_module
        from routers.chats_execute import execute_tool_call

        with patch.object(deps_module, "db_client", mem_db):
            tc = {
                "function": {
                    "name": "search_requests",
                    "arguments": json.dumps({"query": "nonexistentxyz", "rationale": "test"}),
                }
            }
            result = await execute_tool_call(tc)

        assert "No requests found" in result

    @pytest.mark.asyncio
    async def test_matching_results_returned_as_formatted_list(self, mem_db):
        """When requests exist, the result lists them as 'METHOD URL [STATUS]'."""
        import deps as deps_module
        from routers.chats_execute import execute_tool_call
        from models import HttpRequest

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
                    "arguments": json.dumps({"query": "", "rationale": "test"}),
                }
            }
            result = await execute_tool_call(tc)

        assert "GET" in result
        assert "example.com" in result
        assert "200" in result


# ===========================================================================
# execute_tool_call — write_test / run_test
# ===========================================================================

class TestExecuteToolCallWriteTest:
    """Unit tests for the write_test branch of execute_tool_call."""

    @pytest.mark.asyncio
    async def test_writes_file_and_returns_pytest_output(self, tmp_path):
        """write_test writes the code to disk and returns pytest output."""
        import deps as deps_module
        from routers.chats_execute import execute_tool_call

        code = "def test_always_passes():\n    assert 1 + 1 == 2\n"

        with patch.object(deps_module, "TESTS_DIR", tmp_path), \
             patch.object(deps_module, "run_pytest", new=AsyncMock(return_value="1 passed")):
            tc = {
                "function": {
                    "name": "write_test",
                    "arguments": json.dumps({
                        "filename": "test_simple.py",
                        "code": code,
                        "rationale": "test",
                    }),
                }
            }
            result = await execute_tool_call(tc)

        assert (tmp_path / "test_simple.py").exists()
        assert isinstance(result, str)
        assert len(result) > 0

    @pytest.mark.asyncio
    async def test_path_traversal_in_filename_is_sanitised(self, tmp_path):
        """Filenames with path separators or '..' must be sanitised."""
        import deps as deps_module
        from routers.chats_execute import execute_tool_call

        code = "def test_x():\n    pass\n"

        with patch.object(deps_module, "TESTS_DIR", tmp_path), \
             patch.object(deps_module, "run_pytest", new=AsyncMock(return_value="1 passed")):
            tc = {
                "function": {
                    "name": "write_test",
                    "arguments": json.dumps({
                        "filename": "../../evil/test_escape.py",
                        "code": code,
                        "rationale": "test",
                    }),
                }
            }
            result = await execute_tool_call(tc)

        written = list(tmp_path.glob("*.py"))
        assert len(written) == 1
        assert written[0].parent == tmp_path

    @pytest.mark.asyncio
    async def test_strips_markdown_fences_from_code(self, tmp_path):
        """Code wrapped in ```python ... ``` fences must be stripped before writing."""
        import deps as deps_module
        from routers.chats_execute import execute_tool_call

        fenced_code = "```python\ndef test_fenced():\n    assert True\n```"

        with patch.object(deps_module, "TESTS_DIR", tmp_path), \
             patch.object(deps_module, "run_pytest", new=AsyncMock(return_value="1 passed")):
            tc = {
                "function": {
                    "name": "write_test",
                    "arguments": json.dumps({
                        "filename": "test_fenced.py",
                        "code": fenced_code,
                        "rationale": "test",
                    }),
                }
            }
            result = await execute_tool_call(tc)

        written = (tmp_path / "test_fenced.py").read_text()
        assert "```" not in written, "Markdown fences were not stripped"


class TestExecuteToolCallRunTest:
    """Unit tests for the run_test branch of execute_tool_call."""

    @pytest.mark.asyncio
    async def test_runs_existing_file_and_returns_output(self, tmp_path):
        """run_test on an existing file returns pytest output."""
        import deps as deps_module
        from routers.chats_execute import execute_tool_call

        test_file = tmp_path / "test_existing.py"
        test_file.write_text("def test_ok():\n    assert True\n")

        with patch.object(deps_module, "TESTS_DIR", tmp_path), \
             patch.object(deps_module, "run_pytest", new=AsyncMock(return_value="1 passed")) as mock_run:
            tc = {
                "function": {
                    "name": "run_test",
                    "arguments": json.dumps({"filename": "test_existing.py", "rationale": "test"}),
                }
            }
            result = await execute_tool_call(tc)

        assert isinstance(result, str)
        assert len(result) > 0
        mock_run.assert_called_once()

    @pytest.mark.asyncio
    async def test_missing_file_returns_helpful_error(self, tmp_path):
        """run_test on a non-existent file returns a '[FERRET]' error message."""
        import deps as deps_module
        from routers.chats_execute import execute_tool_call

        with patch.object(deps_module, "TESTS_DIR", tmp_path):
            tc = {
                "function": {
                    "name": "run_test",
                    "arguments": json.dumps({"filename": "test_does_not_exist.py", "rationale": "test"}),
                }
            }
            result = await execute_tool_call(tc)

        assert "[FERRET]" in result
        assert "not found" in result.lower() or "write_test" in result


# ===========================================================================
# execute_tool_call — unknown tool
# ===========================================================================

class TestExecuteToolCallUnknown:
    @pytest.mark.asyncio
    async def test_unknown_tool_returns_error_string(self):
        """An unrecognised tool name returns a '[FERRET] Unknown tool' message."""
        from routers.chats_execute import execute_tool_call

        tc = {
            "function": {
                "name": "do_something_weird",
                "arguments": "{}",
            }
        }
        result = await execute_tool_call(tc)
        assert "[FERRET] Unknown tool" in result


# ===========================================================================
# execute_tool_call — list_sources / read_source
# ===========================================================================

async def test_list_sources_no_project_dir(tmp_path):
    """list_sources returns a helpful message when the project dir doesn't exist."""
    import deps as deps_module
    from routers.chats_execute import execute_tool_call

    with patch.object(deps_module, "SOURCES_DIR", tmp_path / "sources"):
        result = await execute_tool_call(_make_tc("list_sources", rationale="test"), project_id="proj-x")

    assert "No sources found" in result


async def test_list_sources_empty_dir(tmp_path):
    """list_sources returns a helpful message when the project dir is empty."""
    import deps as deps_module
    from routers.chats_execute import execute_tool_call

    sources_root = tmp_path / "sources"
    (sources_root / "proj-empty").mkdir(parents=True)

    with patch.object(deps_module, "SOURCES_DIR", sources_root):
        result = await execute_tool_call(_make_tc("list_sources", rationale="test"), project_id="proj-empty")

    assert "No sources found" in result


async def test_list_sources_returns_filenames(tmp_path):
    """list_sources returns a formatted list of filenames and sizes."""
    import deps as deps_module
    from routers.chats_execute import execute_tool_call

    sources_root = tmp_path / "sources"
    proj_dir = sources_root / "proj-abc"
    proj_dir.mkdir(parents=True)
    (proj_dir / "openapi.yaml").write_text("openapi: 3.0.0")
    (proj_dir / "README.md").write_text("# Docs")

    with patch.object(deps_module, "SOURCES_DIR", sources_root):
        result = await execute_tool_call(_make_tc("list_sources", rationale="test"), project_id="proj-abc")

    assert "openapi.yaml" in result
    assert "README.md" in result
    assert "KB" in result


async def test_read_source_missing_filename(tmp_path):
    """read_source returns an error when filename arg is empty."""
    import deps as deps_module
    from routers.chats_execute import execute_tool_call

    with patch.object(deps_module, "SOURCES_DIR", tmp_path / "sources"):
        result = await execute_tool_call(_make_tc("read_source", filename="", rationale="test"), project_id="proj-x")

    assert "filename is required" in result


async def test_read_source_file_not_found(tmp_path):
    """read_source returns a helpful message when the file doesn't exist."""
    import deps as deps_module
    from routers.chats_execute import execute_tool_call

    sources_root = tmp_path / "sources"
    sources_root.mkdir()

    with patch.object(deps_module, "SOURCES_DIR", sources_root):
        result = await execute_tool_call(
            _make_tc("read_source", filename="ghost.md", rationale="test"), project_id="proj-x"
        )

    assert "not found" in result
    assert "list_sources" in result


async def test_read_source_returns_content(tmp_path):
    """read_source returns the file content with a header line."""
    import deps as deps_module
    from routers.chats_execute import execute_tool_call

    sources_root = tmp_path / "sources"
    proj_dir = sources_root / "proj-read"
    proj_dir.mkdir(parents=True)
    (proj_dir / "spec.yaml").write_text("openapi: 3.0.0\ninfo:\n  title: Test API")

    with patch.object(deps_module, "SOURCES_DIR", sources_root):
        result = await execute_tool_call(
            _make_tc("read_source", filename="spec.yaml", rationale="test"), project_id="proj-read"
        )

    assert "spec.yaml" in result
    assert "openapi: 3.0.0" in result
    assert "KB" in result


async def test_read_source_strips_path_traversal(tmp_path):
    """read_source strips directory components from the filename (no traversal)."""
    import deps as deps_module
    from routers.chats_execute import execute_tool_call

    sources_root = tmp_path / "sources"
    proj_dir = sources_root / "proj-safe"
    proj_dir.mkdir(parents=True)
    (proj_dir / "safe.md").write_text("safe content")

    with patch.object(deps_module, "SOURCES_DIR", sources_root):
        result = await execute_tool_call(
            _make_tc("read_source", filename="../../safe.md", rationale="test"), project_id="proj-safe"
        )

    assert "safe content" in result


# ===========================================================================
# GET /api/tools — tool catalogue endpoint
# ===========================================================================

@pytest.mark.asyncio
async def test_get_tools_returns_list(client, mem_db):
    """GET /api/tools returns a non-empty list of {name, label} objects."""
    resp = await client.get("/api/tools")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) > 0


@pytest.mark.asyncio
async def test_get_tools_contains_expected_names(client, mem_db):
    """GET /api/tools includes all known tool names."""
    resp = await client.get("/api/tools")
    names = {t["name"] for t in resp.json()}
    expected = {
        "search_requests", "get_request_detail", "create_finding", "list_findings",
        "write_test", "run_test", "read_test", "pip_install", "run_script",
        "run_katana", "run_ffuf", "run_nuclei", "http_request", "list_sources", "read_source",
    }
    assert expected == names


@pytest.mark.asyncio
async def test_get_tools_each_has_label(client, mem_db):
    """Every tool entry returned by GET /api/tools has a non-empty label."""
    resp = await client.get("/api/tools")
    for tool in resp.json():
        assert "label" in tool, f"Tool {tool['name']!r} missing label"
        assert tool["label"], f"Tool {tool['name']!r} has empty label"


@pytest.mark.asyncio
async def test_get_tools_each_has_group(client, mem_db):
    """Every tool entry returned by GET /api/tools has a non-empty group."""
    resp = await client.get("/api/tools")
    for tool in resp.json():
        assert "group" in tool, f"Tool {tool['name']!r} missing group"
        assert tool["group"], f"Tool {tool['name']!r} has empty group"


@pytest.mark.asyncio
async def test_get_tools_groups_are_known_values(client, mem_db):
    """All tool groups are one of the five canonical group names."""
    expected_groups = {"Proxy History", "Findings", "Testing", "Execution", "Sources"}
    resp = await client.get("/api/tools")
    for tool in resp.json():
        assert tool["group"] in expected_groups, (
            f"Tool {tool['name']!r} has unexpected group {tool['group']!r}"
        )


@pytest.mark.asyncio
async def test_get_tools_all_groups_represented(client, mem_db):
    """All five canonical groups have at least one tool."""
    expected_groups = {"Proxy History", "Findings", "Testing", "Execution", "Sources"}
    resp = await client.get("/api/tools")
    present_groups = {t["group"] for t in resp.json()}
    assert expected_groups == present_groups


# ===========================================================================
# resolve_tools — filtering helper
# ===========================================================================

def test_resolve_tools_none_returns_all():
    """resolve_tools(None) returns the full SESSION_CHAT_TOOLS list."""
    from routers.chats_tools import SESSION_CHAT_TOOLS, resolve_tools
    result = resolve_tools(None)
    assert result == SESSION_CHAT_TOOLS


def test_resolve_tools_empty_list_returns_empty():
    """resolve_tools([]) means all tools disabled — returns an empty list."""
    from routers.chats_tools import resolve_tools
    result = resolve_tools([])
    assert result == []


def test_resolve_tools_filters_by_name():
    """resolve_tools(['search_requests']) returns only that tool."""
    from routers.chats_tools import resolve_tools
    result = resolve_tools(["search_requests"])
    assert len(result) == 1
    assert result[0]["function"]["name"] == "search_requests"


def test_resolve_tools_unknown_names_ignored():
    """resolve_tools with unknown names silently ignores them."""
    from routers.chats_tools import resolve_tools
    result = resolve_tools(["nonexistent_tool"])
    assert result == []


def test_resolve_tools_label_present_in_result():
    """The label key is present in SESSION_CHAT_TOOLS and preserved by resolve_tools."""
    from routers.chats_tools import resolve_tools
    result = resolve_tools(["search_requests"])
    assert "label" in result[0]["function"]


def test_resolve_tools_group_present_in_result():
    """The group key is present in SESSION_CHAT_TOOLS and preserved by resolve_tools."""
    from routers.chats_tools import resolve_tools
    result = resolve_tools(["search_requests"])
    assert "group" in result[0]["function"]
    assert result[0]["function"]["group"] == "Proxy History"


def test_all_tools_have_group_in_session_chat_tools():
    """Every entry in SESSION_CHAT_TOOLS has a non-empty group field."""
    from routers.chats_tools import SESSION_CHAT_TOOLS
    for t in SESSION_CHAT_TOOLS:
        fn = t["function"]
        assert "group" in fn, f"Tool {fn['name']!r} missing group in SESSION_CHAT_TOOLS"
        assert fn["group"], f"Tool {fn['name']!r} has empty group in SESSION_CHAT_TOOLS"

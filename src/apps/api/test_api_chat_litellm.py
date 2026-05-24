"""
FERRET API — pytest unit tests for the LiteLLM-backed streaming chat endpoint.

Covers
------
POST /api/hunts/{session_id}/messages/stream:
  - Returns text/event-stream content-type
  - Emits 'replace' event with accumulated text content
  - Emits 'done' event with full messages list
  - Persists user + assistant messages in DB
  - Empty response with tools enabled → "model returned empty response" notice
  - Empty response with tools disabled → "no tools available" notice
  - Tool call → execute → second LiteLLM call → text response (agentic loop)
  - Tool results are persisted in DB history
  - No API key → SSE error event (not HTTP 5xx)

Run with:
    cd github/ferret/src/apps/api
    pytest test_api_chat_litellm.py -v
"""

import json
import uuid
import pytest
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

# conftest.py provides: client, mem_db fixtures

_SESSION_PAYLOAD = {"name": "LiteLLM test session", "scope": "blank"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _seed_project_key(mem_db, project_id: str = "temp"):
    """Seed a provisioned key so AI endpoints don't return 503."""
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


async def _create_session(client, payload=None):
    """Create a chat session and return its ID."""
    resp = await client.post("/api/hunts", json=payload or _SESSION_PAYLOAD)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _parse_sse(content: bytes) -> list[dict]:
    """Parse SSE response body into a list of event dicts."""
    events = []
    for line in content.decode().splitlines():
        if line.startswith("data: "):
            try:
                events.append(json.loads(line[6:]))
            except json.JSONDecodeError:
                pass
    return events


async def _fake_stream_text(text: str):
    """Async generator yielding a single text chunk then done."""
    yield text, [], None


async def _fake_stream_empty():
    """Async generator yielding an empty response."""
    yield "", [], None


async def _fake_stream_tool_call(tool_name: str, tool_args: dict, tool_id: str = "call_test_1"):
    """Async generator yielding a tool call."""
    tool_calls = [{
        "id": tool_id,
        "type": "function",
        "function": {
            "name": tool_name,
            "arguments": json.dumps(tool_args),
        },
    }]
    yield "", tool_calls, None


# ---------------------------------------------------------------------------
# Basic streaming behaviour
# ---------------------------------------------------------------------------

class TestLiteLLMStreamBasic:

    @pytest.mark.asyncio
    async def test_returns_event_stream_content_type(self, client, mem_db):
        """The endpoint must return text/event-stream."""
        await _seed_project_key(mem_db)
        session_id = await _create_session(client)

        with patch("routers.chats_ai_litellm.stream_ai_completion",
                   return_value=_fake_stream_text("Hello!")):
            resp = await client.post(
                f"/api/hunts/{session_id}/messages/stream",
                json={"message": "Hi"},
            )

        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")

    @pytest.mark.asyncio
    async def test_emits_replace_event_with_text(self, client, mem_db):
        """A text response must emit a 'replace' event with the content."""
        await _seed_project_key(mem_db)
        session_id = await _create_session(client)

        with patch("routers.chats_ai_litellm.stream_ai_completion",
                   return_value=_fake_stream_text("Hello from AI!")):
            resp = await client.post(
                f"/api/hunts/{session_id}/messages/stream",
                json={"message": "Hi"},
            )

        events = _parse_sse(resp.content)
        replace_events = [e for e in events if e.get("type") == "replace"]
        assert len(replace_events) >= 1
        assert any("Hello from AI!" in e.get("content", "") for e in replace_events)

    @pytest.mark.asyncio
    async def test_emits_done_event_with_messages(self, client, mem_db):
        """The endpoint must emit a 'done' event containing the full messages list."""
        await _seed_project_key(mem_db)
        session_id = await _create_session(client)

        with patch("routers.chats_ai_litellm.stream_ai_completion",
                   return_value=_fake_stream_text("Done!")):
            resp = await client.post(
                f"/api/hunts/{session_id}/messages/stream",
                json={"message": "Tell me something"},
            )

        events = _parse_sse(resp.content)
        done_events = [e for e in events if e.get("type") == "done"]
        assert len(done_events) == 1
        assert "messages" in done_events[0]

    @pytest.mark.asyncio
    async def test_persists_user_and_assistant_messages(self, client, mem_db):
        """After streaming, GET /messages must return both user and assistant turns."""
        await _seed_project_key(mem_db)
        session_id = await _create_session(client)

        with patch("routers.chats_ai_litellm.stream_ai_completion",
                   return_value=_fake_stream_text("I am the AI.")):
            await client.post(
                f"/api/hunts/{session_id}/messages/stream",
                json={"message": "Who are you?"},
            )

        msgs_resp = await client.get(f"/api/hunts/{session_id}/messages")
        messages = msgs_resp.json()["messages"]
        roles = [m["role"] for m in messages]
        assert "user" in roles
        assert "assistant" in roles

        user_msgs = [m for m in messages if m["role"] == "user"]
        assert user_msgs[0]["content"] == "Who are you?"

        assistant_msgs = [m for m in messages if m["role"] == "assistant"]
        assert "I am the AI." in assistant_msgs[-1]["content"]


# ---------------------------------------------------------------------------
# Empty response handling
# ---------------------------------------------------------------------------

class TestLiteLLMStreamEmptyResponse:

    @pytest.mark.asyncio
    async def test_empty_response_with_tools_enabled_shows_model_notice(self, client, mem_db):
        """
        When the model returns empty content and tools ARE enabled (enabled_tools=null),
        the notice must say 'model returned an empty response', not 'no tools available'.
        """
        await _seed_project_key(mem_db)
        session_id = await _create_session(client)
        # enabled_tools=null means all tools enabled (default)

        with patch("routers.chats_ai_litellm.stream_ai_completion",
                   return_value=_fake_stream_empty()):
            resp = await client.post(
                f"/api/hunts/{session_id}/messages/stream",
                json={"message": "Hello"},
            )

        events = _parse_sse(resp.content)
        replace_events = [e for e in events if e.get("type") == "replace"]
        assert len(replace_events) >= 1
        content = replace_events[-1].get("content", "")
        assert "empty response" in content.lower()
        assert "no tools" not in content.lower()

    @pytest.mark.asyncio
    async def test_empty_response_with_tools_disabled_shows_tools_notice(self, client, mem_db):
        """
        When the model returns empty content and tools are DISABLED (enabled_tools=[]),
        the notice must say 'no tools available'.
        """
        await _seed_project_key(mem_db)
        session_id = await _create_session(client)

        # Disable all tools for this session
        await client.patch(
            f"/api/hunts/{session_id}",
            json={"enabled_tools": []},
        )

        with patch("routers.chats_ai_litellm.stream_ai_completion",
                   return_value=_fake_stream_empty()):
            resp = await client.post(
                f"/api/hunts/{session_id}/messages/stream",
                json={"message": "Hello"},
            )

        events = _parse_sse(resp.content)
        replace_events = [e for e in events if e.get("type") == "replace"]
        assert len(replace_events) >= 1
        content = replace_events[-1].get("content", "")
        assert "no tools" in content.lower()


# ---------------------------------------------------------------------------
# Agentic loop — tool call → execute → second LiteLLM call → text
# ---------------------------------------------------------------------------

class TestLiteLLMStreamAgenticLoop:
    """
    Tests for the multi-turn agentic loop in stream_session_message_v2.

    This is the critical regression test for the for...else bug where tool
    execution was in the else clause and never ran during normal operation.
    """

    @pytest.mark.asyncio
    async def test_tool_call_executes_and_loops_to_final_answer(self, client, mem_db):
        """
        When the model returns a tool call, the endpoint must:
        1. Execute the tool
        2. Append the tool result to the message history
        3. Call LiteLLM again with the tool result included
        4. Return the final text response

        This test catches the for...else bug where tool execution was in the
        else clause and never ran during normal operation.
        """
        await _seed_project_key(mem_db)
        session_id = await _create_session(client)

        call_count = 0

        async def _two_turn_stream(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # First call: return a tool call
                async for chunk in _fake_stream_tool_call(
                    "search_requests",
                    {"query": "", "rationale": "Find all requests"},
                    tool_id="call_search_1",
                ):
                    yield chunk
            else:
                # Second call (after tool result): return final text
                async for chunk in _fake_stream_text("Found 0 requests. Nothing to report."):
                    yield chunk

        mock_tool_result = "[FERRET] No requests found matching your query."

        with patch("routers.chats_ai_litellm.stream_ai_completion", side_effect=_two_turn_stream), \
             patch("chats_engine.execute_tool_call",
                   new=AsyncMock(return_value=mock_tool_result)):
            resp = await client.post(
                f"/api/hunts/{session_id}/messages/stream",
                json={"message": "Search for requests"},
            )

        assert resp.status_code == 200
        events = _parse_sse(resp.content)

        # Must have called LiteLLM twice (once for tool call, once for final answer)
        assert call_count == 2, f"Expected 2 LiteLLM calls, got {call_count}"

        # Must have emitted tool_start and tool_result events
        tool_start_events = [e for e in events if e.get("type") == "tool_start"]
        tool_result_events = [e for e in events if e.get("type") == "tool_result"]
        assert len(tool_start_events) >= 1, "Expected tool_start event"
        assert len(tool_result_events) >= 1, "Expected tool_result event"

        # Final replace event must contain the second-turn text
        replace_events = [e for e in events if e.get("type") == "replace"]
        final_content = replace_events[-1].get("content", "") if replace_events else ""
        assert "Nothing to report" in final_content

        # Done event must be present
        done_events = [e for e in events if e.get("type") == "done"]
        assert len(done_events) == 1

    @pytest.mark.asyncio
    async def test_tool_results_persisted_in_history(self, client, mem_db):
        """
        After an agentic loop, GET /messages must return all turns including
        the tool result message.
        """
        await _seed_project_key(mem_db)
        session_id = await _create_session(client)

        call_count = 0

        async def _two_turn_stream(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                async for chunk in _fake_stream_tool_call(
                    "search_requests",
                    {"query": "", "rationale": "test"},
                    tool_id="call_persist_1",
                ):
                    yield chunk
            else:
                async for chunk in _fake_stream_text("Done."):
                    yield chunk

        with patch("routers.chats_ai_litellm.stream_ai_completion", side_effect=_two_turn_stream), \
             patch("chats_engine.execute_tool_call",
                   new=AsyncMock(return_value="tool output")):
            await client.post(
                f"/api/hunts/{session_id}/messages/stream",
                json={"message": "Run a tool"},
            )

        msgs_resp = await client.get(f"/api/hunts/{session_id}/messages")
        messages = msgs_resp.json()["messages"]
        roles = [m["role"] for m in messages]

        assert "user" in roles
        assert "assistant" in roles
        assert "tool" in roles, f"Expected tool message in history, got roles: {roles}"


# ---------------------------------------------------------------------------
# No API key
# ---------------------------------------------------------------------------

class TestLiteLLMStreamNoKey:

    @pytest.mark.asyncio
    async def test_no_key_returns_sse_error_not_http_error(self, client, mem_db):
        """
        When the project has no provisioned key and no global key is configured,
        the endpoint returns HTTP 200 with an SSE error event (not HTTP 503).
        """
        await mem_db.seed_temp_project()
        session_id = await _create_session(client)

        resp = await client.post(
            f"/api/hunts/{session_id}/messages/stream",
            json={"message": "Hello"},
        )

        assert resp.status_code == 200
        # The SSE body should contain an error event
        assert "error" in resp.text or "notice" in resp.text or "key" in resp.text.lower()

"""
FERRET API — pytest unit tests for chat session endpoints.

Covers
------
Chat Sessions CRUD:
  - GET  /api/chats                     (empty list)
  - POST /api/chats                     (create, 201)
  - GET  /api/chats/{id}/messages       (empty messages list)
  - DELETE /api/chats/{id}              (204)
  - DELETE /api/chats/{nonexistent}     (404)

POST /api/chats/{id}/messages — send_session_message fix:
  - Returns 200 with messages list when OpenRouter succeeds
  - Persists user + assistant turns (readable via GET messages)
  - Normalises null-content history messages so OpenRouter never sees content=None
  - Prepends a system prompt as the first message to OpenRouter
  - Returns 502 (not 500) when OpenRouter returns an HTTP error

POST /api/chats/{id}/messages — project_id derived from session (regression):
  - Uses the session's own project_id to look up the provisioned key, not the
    query-param default ("temp"), so a session created under a real project
    correctly uses that project's key.

POST /api/chats/{id}/messages — model resolution chain:
  - body.model overrides everything
  - project.default_model is used when body.model is absent
  - deps.OPENROUTER_MODEL is the final fallback

Run with:
    cd github/monorepo/tools/ferret/src/apps/api
    pytest test_api_chat_sessions.py -v
"""

import uuid
import pytest
import httpx
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

# conftest.py provides: client, mem_db, client_with_tests_dir fixtures

_CHAT_SESSION_PAYLOAD = {
    "name": "Test session",
    "scope": "blank",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_openrouter_response(content: str = "Hello from AI") -> MagicMock:
    """Return a mock httpx.Response shaped like a successful OpenRouter reply."""
    mock_resp = MagicMock()
    mock_resp.json.return_value = {
        "choices": [{"message": {"role": "assistant", "content": content}}]
    }
    mock_resp.raise_for_status = MagicMock()
    return mock_resp


def _make_async_client_ctx(mock_response: MagicMock):
    """
    Return a replacement for httpx.AsyncClient that works as an async context manager.

    The endpoint does:
        async with httpx.AsyncClient(...) as client:
            resp = await client.post(...)

    So we need:
        httpx.AsyncClient(...)  → context-manager mock
        async with ...          → yields inner mock
        inner.post(...)         → returns mock_response
    """
    inner = MagicMock()
    inner.post = AsyncMock(return_value=mock_response)
    inner.request = AsyncMock(return_value=mock_response)

    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=inner)
    cm.__aexit__ = AsyncMock(return_value=False)

    cls_mock = MagicMock(return_value=cm)
    return cls_mock, inner


def _make_async_client_ctx_raising(exc: Exception):
    """Like _make_async_client_ctx but the inner .post() raises exc."""
    inner = MagicMock()
    inner.post = AsyncMock(side_effect=exc)
    inner.request = AsyncMock(side_effect=exc)

    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=inner)
    cm.__aexit__ = AsyncMock(return_value=False)

    cls_mock = MagicMock(return_value=cm)
    return cls_mock, inner


def _make_capturing_async_client_ctx():
    """
    Like _make_async_client_ctx but captures the kwargs passed to .post()
    so tests can inspect the messages array sent to OpenRouter.
    Returns (cls_mock, captured_kwargs_list).
    """
    captured: list[dict] = []

    async def _capture(*args, **kwargs):
        captured.append(kwargs)
        return _make_openrouter_response("OK")

    inner = MagicMock()
    inner.post = AsyncMock(side_effect=_capture)
    inner.request = AsyncMock(side_effect=_capture)

    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=inner)
    cm.__aexit__ = AsyncMock(return_value=False)

    cls_mock = MagicMock(return_value=cm)
    return cls_mock, captured


async def _seed_project_key(mem_db, project_id: str = "temp"):
    """Seed a provisioned key for a project so AI endpoints don't return 503."""
    from models import ProjectApiKey
    # Ensure the project row exists (mem_db fixture doesn't auto-seed temp)
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


# ===========================================================================
# Chat Sessions CRUD
# ===========================================================================

class TestChatSessionsEmpty:
    """GET /api/chats returns an empty list when the DB is fresh."""

    @pytest.mark.asyncio
    async def test_get_chats_empty(self, client):
        resp = await client.get("/api/chats")
        assert resp.status_code == 200
        assert resp.json() == []


class TestChatSessionsCreate:
    """POST /api/chats creates a session and returns 201."""

    @pytest.mark.asyncio
    async def test_create_session_returns_201(self, client):
        resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        assert resp.status_code == 201

    @pytest.mark.asyncio
    async def test_create_session_body_has_id(self, client):
        resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        data = resp.json()
        assert "id" in data
        assert len(data["id"]) > 0

    @pytest.mark.asyncio
    async def test_create_session_body_has_correct_name(self, client):
        resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        assert resp.json()["name"] == _CHAT_SESSION_PAYLOAD["name"]

    @pytest.mark.asyncio
    async def test_create_session_appears_in_list(self, client):
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        list_resp = await client.get("/api/chats")
        assert list_resp.status_code == 200
        ids = [s["id"] for s in list_resp.json()]
        assert session_id in ids

    @pytest.mark.asyncio
    async def test_create_session_with_scope_data(self, client):
        payload = {
            "name": "Scoped session",
            "scope": "single",
            "scope_data": {"request_id": "abc-123"},
        }
        resp = await client.post("/api/chats", json=payload)
        assert resp.status_code == 201
        assert resp.json()["scope"] == "single"


class TestChatSessionMessages:
    """GET /api/chats/{id}/messages."""

    @pytest.mark.asyncio
    async def test_get_messages_empty_for_new_session(self, client):
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        resp = await client.get(f"/api/chats/{session_id}/messages")
        assert resp.status_code == 200
        data = resp.json()
        assert "messages" in data
        assert data["messages"] == []

    @pytest.mark.asyncio
    async def test_get_messages_nonexistent_session_returns_200_empty(self, client):
        # The endpoint doesn't validate session existence — it just returns empty
        resp = await client.get("/api/chats/nonexistent-session/messages")
        assert resp.status_code == 200
        assert resp.json()["messages"] == []


class TestChatSessionsDelete:
    """DELETE /api/chats/{id}."""

    @pytest.mark.asyncio
    async def test_delete_session_returns_204(self, client):
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        resp = await client.delete(f"/api/chats/{session_id}")
        assert resp.status_code == 204

    @pytest.mark.asyncio
    async def test_delete_session_removes_from_list(self, client):
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        await client.delete(f"/api/chats/{session_id}")

        list_resp = await client.get("/api/chats")
        ids = [s["id"] for s in list_resp.json()]
        assert session_id not in ids

    @pytest.mark.asyncio
    async def test_delete_nonexistent_session_returns_404(self, client):
        resp = await client.delete("/api/chats/nonexistent-session-xyz")
        assert resp.status_code == 404


# ===========================================================================
# POST /api/chats/{id}/messages — send_session_message fix
# ===========================================================================

class TestSendSessionMessage:
    """
    POST /api/chats/{session_id}/messages

    These tests verify the fix for the 400 Bad Request error from OpenRouter
    caused by null content fields and missing system prompt.
    """

    @pytest.mark.asyncio
    async def test_send_message_returns_200_with_messages(self, client, mem_db):
        """A successful OpenRouter call returns 200 with a messages list."""
        await _seed_project_key(mem_db)
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        cls_mock, _ = _make_async_client_ctx(_make_openrouter_response("I can help with that."))

        with patch("routers.chats.httpx.AsyncClient", cls_mock):
            resp = await client.post(
                f"/api/chats/{session_id}/messages",
                json={"message": "Hello", "model": "google/gemini-2.5-flash-preview"},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert "messages" in data
        roles = [m["role"] for m in data["messages"]]
        assert "user" in roles
        assert "assistant" in roles

    @pytest.mark.asyncio
    async def test_send_message_persists_both_turns(self, client, mem_db):
        """
        After a successful call, GET /api/chats/{id}/messages must return
        both the user message and the assistant reply.
        """
        await _seed_project_key(mem_db)
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        cls_mock, _ = _make_async_client_ctx(_make_openrouter_response("Persisted reply"))

        with patch("routers.chats.httpx.AsyncClient", cls_mock):
            await client.post(
                f"/api/chats/{session_id}/messages",
                json={"message": "Persist me"},
            )

        get_resp = await client.get(f"/api/chats/{session_id}/messages")
        assert get_resp.status_code == 200
        messages = get_resp.json()["messages"]
        assert len(messages) == 2
        assert messages[0]["role"] == "user"
        assert messages[0]["content"] == "Persist me"
        assert messages[1]["role"] == "assistant"
        assert messages[1]["content"] == "Persisted reply"

    @pytest.mark.asyncio
    async def test_send_message_normalises_null_content_in_history(self, client, mem_db):
        """
        Root-cause regression test: if a prior assistant message has content=None
        (e.g. a tool-call turn), the endpoint must coerce it to "" before sending
        to OpenRouter. Sending None causes OpenRouter to return 400.
        """
        await _seed_project_key(mem_db)
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        # Seed a prior assistant message with content=None, bypassing the FK
        # (chat_messages.request_id FK → requests.id; session IDs are not in
        # requests, so we temporarily disable FK enforcement for this insert).
        await mem_db._db.execute("PRAGMA foreign_keys=OFF")
        await mem_db.append_chat_message(session_id, {"role": "assistant", "content": None})
        await mem_db._db.execute("PRAGMA foreign_keys=ON")

        cls_mock, captured = _make_capturing_async_client_ctx()

        with patch("routers.chats.httpx.AsyncClient", cls_mock):
            resp = await client.post(
                f"/api/chats/{session_id}/messages",
                json={"message": "Will this 400?"},
            )

        assert resp.status_code == 200
        assert captured, "No call was made to OpenRouter"
        sent_messages = captured[0].get("json", {}).get("messages", [])
        for msg in sent_messages:
            assert msg.get("content") is not None, (
                f"Message role={msg.get('role')} had content=None — "
                "OpenRouter would reject this with 400"
            )

    @pytest.mark.asyncio
    async def test_send_message_includes_system_prompt(self, client, mem_db):
        """
        The first message in the array sent to OpenRouter must be a system prompt.
        Without it the model has no context about its role.
        """
        await _seed_project_key(mem_db)
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        cls_mock, captured = _make_capturing_async_client_ctx()

        with patch("routers.chats.httpx.AsyncClient", cls_mock):
            await client.post(
                f"/api/chats/{session_id}/messages",
                json={"message": "Any message"},
            )

        assert captured, "No call was made to OpenRouter"
        sent_messages = captured[0].get("json", {}).get("messages", [])
        assert sent_messages, "messages array was empty"
        assert sent_messages[0]["role"] == "system", (
            "First message sent to OpenRouter must be the system prompt"
        )

    @pytest.mark.asyncio
    async def test_send_message_openrouter_error_returns_502(self, client, mem_db):
        """
        When OpenRouter returns an HTTP error the endpoint must return 502,
        not 500, so callers can distinguish a gateway error from a server bug.
        """
        await _seed_project_key(mem_db)
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        error_response = MagicMock()
        error_response.status_code = 400
        error_response.text = "Bad Request"

        exc = httpx.HTTPStatusError(
            "400 Bad Request",
            request=MagicMock(),
            response=error_response,
        )
        cls_mock, _ = _make_async_client_ctx_raising(exc)

        with patch("routers.chats.httpx.AsyncClient", cls_mock):
            resp = await client.post(
                f"/api/chats/{session_id}/messages",
                json={"message": "Trigger error"},
            )

        assert resp.status_code == 502
        assert "400" in resp.json()["detail"]


# ===========================================================================
# POST /api/chats/{id}/messages — project_id derived from session (regression)
# ===========================================================================

class TestSendSessionMessageProjectIdFromSession:
    """
    Regression: send_session_message must derive project_id from the session
    record, not from the query-param default ("temp").

    Before the fix, a session created under a real project would always look up
    the key for "temp" (which has none), returning 503.
    """

    @pytest.mark.asyncio
    async def test_uses_session_project_key_not_temp(self, client, mem_db):
        """
        Session created under a real project uses that project's provisioned key.
        The "temp" project has no key; only the real project does.
        """
        from models import Project, ProjectApiKey
        from datetime import datetime

        # Create a real project and seed a key for it
        project = Project(
            name="Real Project",
            description="",
            color="#f97316",
            is_temp=False,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        await mem_db.create_project(project)

        key = ProjectApiKey(
            id=str(uuid.uuid4()),
            project_id=project.id,
            name="real-key",
            key_hash="hash-real",
            key_preview="sk-or-v1-real...0000",
            limit_usd=None,
            created_at=datetime.utcnow().isoformat(),
        )
        await mem_db.store_project_api_key(key, "sk-or-v1-real-key-value")

        # Create a session under the real project (not "temp")
        create_resp = await client.post(
            f"/api/chats?project_id={project.id}",
            json={"name": "Real project session", "scope": "blank"},
        )
        assert create_resp.status_code == 201
        session_id = create_resp.json()["id"]

        cls_mock, captured = _make_capturing_async_client_ctx()

        # Send message WITHOUT passing project_id query param — the endpoint
        # must derive it from the session record.
        with patch("routers.chats.httpx.AsyncClient", cls_mock):
            resp = await client.post(
                f"/api/chats/{session_id}/messages",
                json={"message": "Hello from real project"},
            )

        assert resp.status_code == 200, resp.text
        # Verify the real key was used (not the temp key)
        assert captured, "No call was made to OpenRouter"
        auth_header = captured[0].get("headers", {}).get("Authorization", "")
        assert "real-key-value" in auth_header, (
            f"Expected real project key in Authorization header, got: {auth_header!r}"
        )

    @pytest.mark.asyncio
    async def test_session_under_temp_with_no_key_returns_503(self, client, mem_db):
        """
        A session under 'temp' with no provisioned key returns 503.
        (Ensures the project-id derivation doesn't accidentally bypass the key check.)
        """
        await mem_db.seed_temp_project()
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        resp = await client.post(
            f"/api/chats/{session_id}/messages",
            json={"message": "No key here"},
        )
        assert resp.status_code == 503
        assert "provisioned key" in resp.json()["detail"].lower()


# ===========================================================================
# POST /api/chats/{id}/messages — model resolution chain
# ===========================================================================

class TestSendSessionMessageModelResolution:
    """
    Model resolution: body.model → project.default_model → deps.OPENROUTER_MODEL
    """

    @pytest.mark.asyncio
    async def test_body_model_overrides_project_default(self, client, mem_db):
        """body.model takes precedence over the project's default_model."""
        await _seed_project_key(mem_db)
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        cls_mock, captured = _make_capturing_async_client_ctx()

        with patch("routers.chats.httpx.AsyncClient", cls_mock):
            resp = await client.post(
                f"/api/chats/{session_id}/messages",
                json={"message": "Hi", "model": "openai/gpt-4o"},
            )

        assert resp.status_code == 200, resp.text
        assert captured
        sent_model = captured[0].get("json", {}).get("model")
        assert sent_model == "openai/gpt-4o", f"Expected gpt-4o, got {sent_model!r}"

    @pytest.mark.asyncio
    async def test_project_default_model_used_when_no_body_model(self, client, mem_db):
        """When body.model is absent, the project's default_model is used."""
        from models import Project
        from datetime import datetime
        import deps as _deps

        # Create a project with a custom default_model
        project = Project(
            name="Custom Model Project",
            description="",
            color="#f97316",
            is_temp=False,
            default_model="anthropic/claude-3-haiku",
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        await mem_db.create_project(project)

        from models import ProjectApiKey
        key = ProjectApiKey(
            id=str(uuid.uuid4()),
            project_id=project.id,
            name="key",
            key_hash="hash-custom",
            key_preview="sk-or-v1-cust...0000",
            limit_usd=None,
            created_at=datetime.utcnow().isoformat(),
        )
        await mem_db.store_project_api_key(key, "sk-or-v1-custom-key")

        create_resp = await client.post(
            f"/api/chats?project_id={project.id}",
            json={"name": "Custom model session", "scope": "blank"},
        )
        session_id = create_resp.json()["id"]

        cls_mock, captured = _make_capturing_async_client_ctx()

        with patch("routers.chats.httpx.AsyncClient", cls_mock):
            resp = await client.post(
                f"/api/chats/{session_id}/messages",
                json={"message": "Which model?"},
                # No "model" field — should fall back to project.default_model
            )

        assert resp.status_code == 200, resp.text
        assert captured
        sent_model = captured[0].get("json", {}).get("model")
        assert sent_model == "anthropic/claude-3-haiku", (
            f"Expected project default model, got {sent_model!r}"
        )

    @pytest.mark.asyncio
    async def test_global_env_model_used_as_final_fallback(self, client, mem_db):
        """When neither body.model nor project.default_model is set, deps.OPENROUTER_MODEL is used."""
        import deps as _deps

        await _seed_project_key(mem_db)
        create_resp = await client.post("/api/chats", json=_CHAT_SESSION_PAYLOAD)
        session_id = create_resp.json()["id"]

        cls_mock, captured = _make_capturing_async_client_ctx()
        sentinel_model = "google/gemini-3-flash-preview-sentinel"

        # The temp project now has a default_model set in the schema seed.
        # Clear it directly in the DB so the env-var fallback is exercised.
        await mem_db._db.execute(
            "UPDATE projects SET default_model = NULL WHERE id = 'temp'"
        )
        await mem_db._db.commit()

        # Patch both the routers.chats reference AND the deps module directly,
        # since the container env may have OPENROUTER_MODEL set to a real value.
        with patch("routers.chats.httpx.AsyncClient", cls_mock), \
             patch("routers.chats.deps.OPENROUTER_MODEL", sentinel_model), \
             patch.object(_deps, "OPENROUTER_MODEL", sentinel_model):
            resp = await client.post(
                f"/api/chats/{session_id}/messages",
                json={"message": "Fallback model?"},
            )

        assert resp.status_code == 200, resp.text
        assert captured
        sent_model = captured[0].get("json", {}).get("model")
        assert sent_model == sentinel_model, (
            f"Expected global fallback model, got {sent_model!r}"
        )

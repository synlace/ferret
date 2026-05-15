"""
FERRET API — pytest tests for the /api/setup endpoints.

Covers
------
GET  /api/setup          — returns setup_complete=False on fresh DB
POST /api/setup          — saves config, marks setup complete
GET  /api/setup          — returns setup_complete=True after POST
POST /api/setup/test     — returns {ok: bool} for a provider probe
DELETE /api/setup        — resets setup_complete to False
POST /api/setup (skip)   — "skip" sentinel accepted without api_key
POST /api/setup (bad)    — unknown provider → 422
POST /api/setup (bad)    — cloud provider without api_key → 422

Run with:
    pytest test_api_setup.py -v
"""

import pytest


# ---------------------------------------------------------------------------
# GET /api/setup — initial state
# ---------------------------------------------------------------------------

class TestGetSetupInitial:
    async def test_returns_not_complete_on_fresh_db(self, client):
        r = await client.get("/api/setup")
        assert r.status_code == 200
        data = r.json()
        assert data["setup_complete"] is False
        assert data.get("provider") is None
        assert data.get("model") is None


# ---------------------------------------------------------------------------
# POST /api/setup — valid configs
# ---------------------------------------------------------------------------

class TestPostSetupValid:
    async def test_openrouter_saves_and_marks_complete(self, client):
        payload = {
            "provider": "openrouter",
            "api_key": "sk-or-test-key",
            "model": "google/gemini-2.5-flash-preview",
        }
        r = await client.post("/api/setup", json=payload)
        assert r.status_code == 201
        data = r.json()
        assert data["status"] == "ok"
        assert data["provider"] == "openrouter"

    async def test_get_after_post_returns_complete(self, client):
        await client.post("/api/setup", json={
            "provider": "openai",
            "api_key": "sk-test",
            "model": "gpt-4o",
        })
        r = await client.get("/api/setup")
        assert r.status_code == 200
        data = r.json()
        assert data["setup_complete"] is True
        assert data["provider"] == "openai"
        assert data["model"] == "gpt-4o"

    async def test_openrouter_with_provisioning_key_only(self, client):
        """A provisioning key alone is sufficient for OpenRouter — no api_key needed."""
        payload = {
            "provider": "openrouter",
            "provisioning_key": "sk-or-prov-only",
            "model": "google/gemini-2.5-flash-preview",
        }
        r = await client.post("/api/setup", json=payload)
        assert r.status_code == 201

    async def test_openrouter_with_both_keys(self, client):
        """Both api_key and provisioning_key together is also valid for OpenRouter."""
        payload = {
            "provider": "openrouter",
            "api_key": "sk-or-main",
            "provisioning_key": "sk-or-prov",
            "model": "google/gemini-2.5-flash-preview",
        }
        r = await client.post("/api/setup", json=payload)
        assert r.status_code == 201

    async def test_openrouter_both_keys_setup_complete(self, client):
        """When both api_key and provisioning_key are supplied for OR, setup
        must be marked complete and the provider/model reflected in GET."""
        await client.post("/api/setup", json={
            "provider": "openrouter",
            "api_key": "sk-or-v1-regular",
            "provisioning_key": "sk-or-v1-provisioning",
            "model": "google/gemini-2.5-flash-preview",
        })
        r = await client.get("/api/setup")
        assert r.status_code == 200
        data = r.json()
        assert data["setup_complete"] is True
        assert data["provider"] == "openrouter"
        assert data["model"] == "google/gemini-2.5-flash-preview"

    async def test_ollama_local_no_api_key_required(self, client):
        payload = {
            "provider": "ollama",
            "model": "llama3.3",
        }
        r = await client.post("/api/setup", json=payload)
        assert r.status_code == 201

    async def test_lmstudio_with_custom_base_url(self, client):
        payload = {
            "provider": "lmstudio",
            "base_url": "http://192.168.1.10:1234/v1",
            "model": "local-model",
        }
        r = await client.post("/api/setup", json=payload)
        assert r.status_code == 201

    async def test_skip_sentinel_accepted(self, client):
        r = await client.post("/api/setup", json={
            "provider": "skip",
            "model": "none",
        })
        assert r.status_code == 201
        data = r.json()
        assert data["provider"] == "skip"

    async def test_skip_marks_setup_complete(self, client):
        await client.post("/api/setup", json={"provider": "skip", "model": "none"})
        r = await client.get("/api/setup")
        assert r.json()["setup_complete"] is True

    async def test_all_cloud_providers_accepted(self, client):
        """Each cloud provider key should be accepted when an api_key is supplied."""
        for provider in ("openrouter", "openai", "anthropic", "gemini", "deepseek", "mistral"):
            r = await client.post("/api/setup", json={
                "provider": provider,
                "api_key": "sk-test-key",
                "model": "some-model",
            })
            assert r.status_code == 201, f"Expected 201 for provider={provider}, got {r.status_code}"
            # Reset for next iteration
            await client.delete("/api/setup")

    async def test_all_local_providers_accepted(self, client):
        """Local providers should be accepted without an api_key."""
        for provider in ("ollama", "lmstudio"):
            r = await client.post("/api/setup", json={
                "provider": provider,
                "model": "local-model",
            })
            assert r.status_code == 201, f"Expected 201 for provider={provider}, got {r.status_code}"
            await client.delete("/api/setup")


# ---------------------------------------------------------------------------
# POST /api/setup — validation errors
# ---------------------------------------------------------------------------

class TestPostSetupInvalid:
    async def test_unknown_provider_returns_422(self, client):
        r = await client.post("/api/setup", json={
            "provider": "notareal",
            "api_key": "sk-x",
            "model": "some-model",
        })
        assert r.status_code == 422

    async def test_cloud_provider_without_api_key_returns_422(self, client):
        r = await client.post("/api/setup", json={
            "provider": "openai",
            "model": "gpt-4o",
        })
        assert r.status_code == 422

    async def test_anthropic_without_api_key_returns_422(self, client):
        r = await client.post("/api/setup", json={
            "provider": "anthropic",
            "model": "claude-sonnet-4-5",
        })
        assert r.status_code == 422

    async def test_gemini_without_api_key_returns_422(self, client):
        r = await client.post("/api/setup", json={
            "provider": "gemini",
            "model": "gemini-2.5-flash",
        })
        assert r.status_code == 422

    async def test_openrouter_without_any_key_returns_422(self, client):
        """OpenRouter requires at least one of api_key or provisioning_key."""
        r = await client.post("/api/setup", json={
            "provider": "openrouter",
            "model": "google/gemini-2.5-flash-preview",
        })
        assert r.status_code == 422
        assert "provisioning_key" in r.json()["detail"] or "api_key" in r.json()["detail"]


# ---------------------------------------------------------------------------
# DELETE /api/setup — reset
# ---------------------------------------------------------------------------

class TestDeleteSetup:
    async def test_delete_resets_setup_complete(self, client):
        # First complete setup
        await client.post("/api/setup", json={
            "provider": "openai",
            "api_key": "sk-test",
            "model": "gpt-4o",
        })
        r = await client.get("/api/setup")
        assert r.json()["setup_complete"] is True

        # Then reset
        r = await client.delete("/api/setup")
        assert r.status_code == 204

        r = await client.get("/api/setup")
        assert r.json()["setup_complete"] is False

    async def test_delete_idempotent(self, client):
        """DELETE on an already-reset setup should still return 204."""
        r = await client.delete("/api/setup")
        assert r.status_code == 204
        r = await client.delete("/api/setup")
        assert r.status_code == 204


# ---------------------------------------------------------------------------
# POST /api/setup/test — connectivity probe
# ---------------------------------------------------------------------------

class TestSetupTest:
    async def test_returns_ok_false_for_unreachable_local(self, client):
        """Ollama on a port that is definitely not open should return ok=False."""
        r = await client.post("/api/setup/test", json={
            "provider": "ollama",
            "base_url": "http://127.0.0.1:19999/v1",
            "model": "llama3.3",
        })
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is False
        assert "error" in data

    async def test_openai_invalid_key_returns_ok_false(self, client):
        """An invalid OpenAI key must return ok=False (auth-gated /models endpoint)."""
        r = await client.post("/api/setup/test", json={
            "provider": "openai",
            "api_key": "sk-invalid-key-for-testing",
            "model": "gpt-4o",
        })
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is False
        assert "error" in data

    async def test_openrouter_invalid_api_key_returns_ok_false(self, client):
        """An invalid OpenRouter api_key must return ok=False (/auth/key is auth-gated)."""
        r = await client.post("/api/setup/test", json={
            "provider": "openrouter",
            "api_key": "sk-or-invalid-key",
            "model": "google/gemini-2.5-flash-preview",
        })
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is False
        assert "error" in data

    async def test_openrouter_invalid_provisioning_key_returns_ok_false(self, client):
        """An invalid OpenRouter provisioning_key must return ok=False (/keys is auth-gated)."""
        r = await client.post("/api/setup/test", json={
            "provider": "openrouter",
            "provisioning_key": "sk-or-v1-invalid-prov-key",
            "model": "google/gemini-2.5-flash-preview",
        })
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is False
        assert "error" in data

    async def test_openrouter_no_key_returns_ok_false(self, client):
        """OpenRouter with no key at all must return ok=False immediately."""
        r = await client.post("/api/setup/test", json={
            "provider": "openrouter",
            "model": "google/gemini-2.5-flash-preview",
        })
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is False

    async def test_openrouter_both_keys_invalid_returns_ok_false_with_key_results(self, client):
        """When both keys are provided, both are tested independently.
        The response includes key_results with one entry per key."""
        r = await client.post("/api/setup/test", json={
            "provider": "openrouter",
            "api_key": "sk-or-invalid-api",
            "provisioning_key": "sk-or-v1-invalid-prov",
            "model": "google/gemini-2.5-flash-preview",
        })
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is False
        # Both-key responses use key_results instead of a top-level error
        assert "key_results" in data
        assert len(data["key_results"]) == 2
        labels = {kr["label"] for kr in data["key_results"]}
        assert "API key" in labels
        assert "Provisioning key" in labels
        # Both should have failed
        for kr in data["key_results"]:
            assert kr["ok"] is False

    async def test_anthropic_invalid_key_returns_ok_false(self, client):
        """An invalid Anthropic key must return ok=False (/models requires x-api-key)."""
        r = await client.post("/api/setup/test", json={
            "provider": "anthropic",
            "api_key": "sk-ant-invalid",
            "model": "claude-sonnet-4-5",
        })
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is False
        assert "error" in data

    async def test_response_has_ok_field(self, client):
        """The /test endpoint must always return a dict with an 'ok' key."""
        r = await client.post("/api/setup/test", json={
            "provider": "openai",
            "api_key": "sk-invalid-key-for-testing",
            "model": "gpt-4o",
        })
        assert r.status_code == 200
        data = r.json()
        assert "ok" in data


# ---------------------------------------------------------------------------
# Unit tests: _build_ai_request — per-provider request construction
# ---------------------------------------------------------------------------

class TestBuildAiRequest:
    """Pure unit tests for the _build_ai_request helper in routers/chats.py.

    These do not require a running server — they just verify that the correct
    URL, headers, and body are constructed for each provider format.
    """

    def _cfg(self, fmt: str, base_url: str, key: str = "sk-test") -> dict:
        return {"format": fmt, "base_url": base_url, "_resolved_key": key}

    def test_openai_compat_url(self):
        from routers.chats import _build_ai_request
        url, _, _ = _build_ai_request(
            self._cfg("openai", "https://api.openai.com/v1"),
            "gpt-4o", [], []
        )
        assert url == "https://api.openai.com/v1/chat/completions"

    def test_openrouter_url(self):
        from routers.chats import _build_ai_request
        url, _, _ = _build_ai_request(
            self._cfg("openai", "https://openrouter.ai/api/v1"),
            "google/gemini-2.5-flash-preview", [], []
        )
        assert url == "https://openrouter.ai/api/v1/chat/completions"

    def test_ollama_url(self):
        from routers.chats import _build_ai_request
        url, _, _ = _build_ai_request(
            self._cfg("openai", "http://localhost:11434/v1"),
            "llama3.3", [], []
        )
        assert url == "http://localhost:11434/v1/chat/completions"

    def test_openai_compat_auth_header(self):
        from routers.chats import _build_ai_request
        _, headers, _ = _build_ai_request(
            self._cfg("openai", "https://api.openai.com/v1", "sk-mykey"),
            "gpt-4o", [], []
        )
        assert headers["Authorization"] == "Bearer sk-mykey"

    def test_openai_compat_body_has_model(self):
        from routers.chats import _build_ai_request
        _, _, body = _build_ai_request(
            self._cfg("openai", "https://api.openai.com/v1"),
            "gpt-4o", [{"role": "user", "content": "hi"}], []
        )
        assert body["model"] == "gpt-4o"
        assert body["messages"] == [{"role": "user", "content": "hi"}]

    def test_openai_compat_tools_included(self):
        from routers.chats import _build_ai_request
        tools = [{"type": "function", "function": {"name": "my_tool", "parameters": {}}}]
        _, _, body = _build_ai_request(
            self._cfg("openai", "https://api.openai.com/v1"),
            "gpt-4o", [], tools
        )
        assert body["tools"] == tools
        assert body["tool_choice"] == "auto"

    def test_anthropic_url(self):
        from routers.chats import _build_ai_request
        url, _, _ = _build_ai_request(
            self._cfg("anthropic", "https://api.anthropic.com/v1"),
            "claude-sonnet-4-5", [], []
        )
        assert url == "https://api.anthropic.com/v1/messages"

    def test_anthropic_headers(self):
        from routers.chats import _build_ai_request
        _, headers, _ = _build_ai_request(
            self._cfg("anthropic", "https://api.anthropic.com/v1", "sk-ant-key"),
            "claude-sonnet-4-5", [], []
        )
        assert headers["x-api-key"] == "sk-ant-key"
        assert headers["anthropic-version"] == "2023-06-01"
        assert "Authorization" not in headers

    def test_anthropic_system_prompt_extracted(self):
        from routers.chats import _build_ai_request
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hello"},
        ]
        _, _, body = _build_ai_request(
            self._cfg("anthropic", "https://api.anthropic.com/v1"),
            "claude-sonnet-4-5", messages, []
        )
        assert body["system"] == "You are helpful."
        assert all(m["role"] != "system" for m in body["messages"])

    def test_anthropic_tools_converted(self):
        from routers.chats import _build_ai_request
        tools = [{
            "type": "function",
            "function": {
                "name": "search",
                "description": "Search the web",
                "parameters": {"type": "object", "properties": {}},
            }
        }]
        _, _, body = _build_ai_request(
            self._cfg("anthropic", "https://api.anthropic.com/v1"),
            "claude-sonnet-4-5", [], tools
        )
        assert body["tools"][0]["name"] == "search"
        assert body["tools"][0]["description"] == "Search the web"
        assert "input_schema" in body["tools"][0]


# ---------------------------------------------------------------------------
# Unit tests: _parse_ai_response — per-provider response normalisation
# ---------------------------------------------------------------------------

class TestParseAiResponse:
    """Verify that _parse_ai_response normalises provider responses correctly."""

    def _cfg(self, fmt: str) -> dict:
        return {"format": fmt}

    def test_openai_compat_text(self):
        from routers.chats import _parse_ai_response
        data = {"choices": [{"message": {"role": "assistant", "content": "Hello!"}}]}
        msg = _parse_ai_response(self._cfg("openai"), data)
        assert msg["content"] == "Hello!"
        assert msg["role"] == "assistant"

    def test_openai_compat_tool_call_preserved(self):
        from routers.chats import _parse_ai_response
        tool_call = {"id": "tc1", "type": "function", "function": {"name": "foo", "arguments": "{}"}}
        data = {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [tool_call]}}]}
        msg = _parse_ai_response(self._cfg("openai"), data)
        assert msg["tool_calls"] == [tool_call]

    def test_anthropic_text(self):
        from routers.chats import _parse_ai_response
        data = {"content": [{"type": "text", "text": "Hi there!"}], "stop_reason": "end_turn"}
        msg = _parse_ai_response(self._cfg("anthropic"), data)
        assert msg["content"] == "Hi there!"
        assert msg["role"] == "assistant"

    def test_anthropic_tool_use_converted(self):
        from routers.chats import _parse_ai_response
        import json as _json
        data = {
            "content": [
                {"type": "tool_use", "id": "tu1", "name": "search", "input": {"query": "test"}},
            ],
            "stop_reason": "tool_use",
        }
        msg = _parse_ai_response(self._cfg("anthropic"), data)
        assert len(msg["tool_calls"]) == 1
        tc = msg["tool_calls"][0]
        assert tc["id"] == "tu1"
        assert tc["function"]["name"] == "search"
        assert _json.loads(tc["function"]["arguments"]) == {"query": "test"}

    def test_anthropic_mixed_content(self):
        """Text + tool_use in same response — text extracted, tool call converted."""
        from routers.chats import _parse_ai_response
        data = {
            "content": [
                {"type": "text", "text": "Let me search for that."},
                {"type": "tool_use", "id": "tu2", "name": "search", "input": {}},
            ],
            "stop_reason": "tool_use",
        }
        msg = _parse_ai_response(self._cfg("anthropic"), data)
        assert "Let me search" in msg["content"]
        assert len(msg["tool_calls"]) == 1


# ---------------------------------------------------------------------------
# Unit tests: deps.get_key_for_project — fallback to setup wizard api_key
# ---------------------------------------------------------------------------

class TestGetKeyForProject:
    """Verify the key resolution fallback chain in deps.get_key_for_project."""

    async def test_fallback_to_setup_api_key(self, client):
        """When no provisioned sub-key exists, the setup wizard api_key is returned."""
        # POST setup so the router calls reload_ai_config() and sets _ai_api_key
        r = await client.post("/api/setup", json={
            "provider": "openrouter",
            "api_key": "sk-fallback-key",
            "model": "google/gemini-2.5-flash-preview",
        })
        assert r.status_code == 201

        # The 'temp' project has no provisioned sub-key, so the global key is the fallback
        import deps as deps_module
        key = await deps_module.get_key_for_project("temp")
        assert key == "sk-fallback-key"

    async def test_no_key_returns_none_when_no_setup(self, client):
        """With no setup and no provisioned key, get_key_for_project returns None."""
        import deps as deps_module
        # Force _ai_api_key to empty to simulate a fresh deployment with no setup
        original = deps_module._ai_api_key
        try:
            deps_module._ai_api_key = ""
            key = await deps_module.get_key_for_project("nonexistent-project")
            assert key is None
        finally:
            deps_module._ai_api_key = original

    async def test_provisioned_key_takes_priority_over_global(self, client):
        """A per-project provisioned sub-key beats the global setup api_key."""
        from models import ProjectApiKey
        import deps as deps_module
        import hashlib, uuid

        # Set a global key via setup
        await client.post("/api/setup", json={
            "provider": "openrouter",
            "api_key": "sk-global",
            "model": "google/gemini-2.5-flash-preview",
        })

        # Ensure the temp project row exists (required by FK constraint)
        await deps_module.db_client.seed_temp_project()

        # Store a provisioned sub-key for the 'temp' project directly in the DB
        key_value = "sk-provisioned-subkey"
        key_hash  = hashlib.sha256(key_value.encode()).hexdigest()[:16]
        pkey = ProjectApiKey(
            id=str(uuid.uuid4()),
            project_id="temp",
            name="test-provisioned-key",
            key_hash=key_hash,
            key_preview=key_value[:8] + "...",
            created_at="2025-01-01T00:00:00",
        )
        await deps_module.db_client.store_project_api_key(pkey, key_value)

        resolved = await deps_module.get_key_for_project("temp")
        assert resolved == key_value

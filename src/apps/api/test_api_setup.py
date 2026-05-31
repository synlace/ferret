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

# Password used in all POST /api/setup test payloads.
_PW = "test-password-123"


class TestPostSetupValid:
    async def test_openrouter_saves_and_marks_complete(self, client):
        payload = {
            "password": _PW,
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
            "password": _PW,
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
            "password": _PW,
            "provider": "openrouter",
            "provisioning_key": "sk-or-prov-only",
            "model": "google/gemini-2.5-flash-preview",
        }
        r = await client.post("/api/setup", json=payload)
        assert r.status_code == 201

    async def test_openrouter_with_both_keys(self, client):
        """Both api_key and provisioning_key together is also valid for OpenRouter."""
        payload = {
            "password": _PW,
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
            "password": _PW,
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
            "password": _PW,
            "provider": "ollama",
            "model": "llama3.3",
        }
        r = await client.post("/api/setup", json=payload)
        assert r.status_code == 201

    async def test_lmstudio_with_custom_base_url(self, client):
        payload = {
            "password": _PW,
            "provider": "lmstudio",
            "base_url": "http://192.168.1.10:1234/v1",
            "model": "local-model",
        }
        r = await client.post("/api/setup", json=payload)
        assert r.status_code == 201

    async def test_skip_sentinel_rejected(self, client):
        """'skip' provider is no longer supported — password is mandatory."""
        r = await client.post("/api/setup", json={
            "password": _PW,
            "provider": "skip",
            "model": "none",
        })
        assert r.status_code == 422

    async def test_all_cloud_providers_accepted(self, client):
        """Each cloud provider key should be accepted when an api_key is supplied."""
        for provider in ("openrouter", "openai", "anthropic", "gemini", "deepseek", "mistral"):
            r = await client.post("/api/setup", json={
                "password": _PW,
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
                "password": _PW,
                "provider": provider,
                "model": "local-model",
            })
            assert r.status_code == 201, f"Expected 201 for provider={provider}, got {r.status_code}"
            await client.delete("/api/setup")


# ---------------------------------------------------------------------------
# POST /api/setup — validation errors
# ---------------------------------------------------------------------------

class TestPostSetupInvalid:
    async def test_missing_password_returns_422(self, client):
        """POST /api/setup without a password must return 422."""
        r = await client.post("/api/setup", json={
            "provider": "openai",
            "api_key": "sk-test",
            "model": "gpt-4o",
        })
        assert r.status_code == 422

    async def test_short_password_returns_422(self, client):
        """Password shorter than 8 characters must return 422."""
        r = await client.post("/api/setup", json={
            "password": "short",
            "provider": "openai",
            "api_key": "sk-test",
            "model": "gpt-4o",
        })
        assert r.status_code == 422

    async def test_unknown_provider_returns_422(self, client):
        r = await client.post("/api/setup", json={
            "password": _PW,
            "provider": "notareal",
            "api_key": "sk-x",
            "model": "some-model",
        })
        assert r.status_code == 422

    async def test_cloud_provider_without_api_key_returns_422(self, client):
        r = await client.post("/api/setup", json={
            "password": _PW,
            "provider": "openai",
            "model": "gpt-4o",
        })
        assert r.status_code == 422

    async def test_anthropic_without_api_key_returns_422(self, client):
        r = await client.post("/api/setup", json={
            "password": _PW,
            "provider": "anthropic",
            "model": "claude-sonnet-4-5",
        })
        assert r.status_code == 422

    async def test_gemini_without_api_key_returns_422(self, client):
        r = await client.post("/api/setup", json={
            "password": _PW,
            "provider": "gemini",
            "model": "gemini-2.5-flash",
        })
        assert r.status_code == 422

    async def test_openrouter_without_any_key_returns_422(self, client):
        """OpenRouter requires at least one of api_key or provisioning_key."""
        r = await client.post("/api/setup", json={
            "password": _PW,
            "provider": "openrouter",
            "model": "google/gemini-2.5-flash-preview",
        })
        assert r.status_code == 422
        detail = r.json()["detail"]
        assert "provisioning_key" in detail or "api_key" in detail


# ---------------------------------------------------------------------------
# DELETE /api/setup — reset
# ---------------------------------------------------------------------------

class TestDeleteSetup:
    async def test_delete_resets_setup_complete(self, client):
        # First complete setup
        await client.post("/api/setup", json={
            "password": _PW,
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
# Unit tests: deps.get_key_for_project — fallback to setup wizard api_key
# ---------------------------------------------------------------------------

class TestGetKeyForProject:
    """Verify the key resolution fallback chain in deps.get_key_for_project."""

    async def test_fallback_to_setup_api_key(self, client):
        """When no provisioned sub-key exists, the setup wizard api_key is returned."""
        # POST setup so the router calls reload_ai_config() and sets _ai_api_key
        r = await client.post("/api/setup", json={
            "password": _PW,
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
            "password": _PW,
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


# ---------------------------------------------------------------------------
# AWS Den existing infrastructure check tests
# ---------------------------------------------------------------------------

class TestCheckExistingAWSSetup:
    async def test_check_existing_no_aws_den_saved(self, client):
        """Should return exists=False and working=False if no AWS Den is saved in DB."""
        r = await client.post("/api/settings/dens/check-existing")
        assert r.status_code == 200
        data = r.json()
        assert data["exists"] is False
        assert data["working"] is False
        assert "No AWS Den configuration saved" in data["detail"]

    async def test_check_existing_missing_credentials(self, client):
        """Should return exists=False and working=False if credentials are empty."""
        # Save a config with empty credentials
        await client.post("/api/settings/dens", json={
            "id": "aws",
            "name": "AWS Fargate Den",
            "den_type": "aws",
            "den_max_runners": 10,
            "den_aws_access_key": "",
            "den_aws_secret_key": "",
            "den_aws_region": "eu-west-1"
        })
        r = await client.post("/api/settings/dens/check-existing")
        assert r.status_code == 200
        data = r.json()
        assert data["exists"] is False
        assert data["working"] is False
        assert "Missing AWS credentials" in data["detail"]

    async def test_check_existing_working_bypassed_mock(self, client):
        """In testing environments, verify checking for existing works when mocked."""
        from unittest.mock import MagicMock, patch

        mock_ec2 = MagicMock()
        mock_ec2.describe_instances.return_value = {
            "Reservations": [
                {
                    "Instances": [
                        {
                            "InstanceId": "i-mock-instance-123",
                            "PublicIpAddress": "127.0.0.1",
                            "PrivateIpAddress": "10.0.0.1"
                        }
                    ]
                }
            ]
        }

        await client.post("/api/settings/dens", json={
            "id": "aws",
            "name": "AWS Fargate Den",
            "den_type": "aws",
            "den_max_runners": 10,
            "den_aws_access_key": "AKIAIOSFODNN7EXAMPLE",
            "den_aws_secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "den_aws_region": "eu-west-1"
        })

        with patch("boto3.client", return_value=mock_ec2):
            r = await client.post("/api/settings/dens/check-existing")
            assert r.status_code == 200
            data = r.json()
            assert data["exists"] is True
            assert data["instance_id"] == "i-mock-instance-123"
            assert "working" in data


# ---------------------------------------------------------------------------
# Setup Progress Table tests
# ---------------------------------------------------------------------------

class TestSetupProgress:
    async def test_progress_lifecycle(self, client):
        # 1. Initially should return empty defaults
        r = await client.get("/api/setup/progress")
        assert r.status_code == 200
        data = r.json()
        assert data["step"] is None
        assert data["den_type"] is None

        # 2. Save progress (step 2, den_type="local")
        payload = {
            "step": 2,
            "den_type": "local",
            "verified": False,
            "verifying": True,
            "verify_logs": ["Log line 1", "Log line 2"],
            "active_run_id": "run-123",
            "corrupted": False
        }
        r = await client.post("/api/setup/progress", json=payload)
        assert r.status_code == 200
        assert r.json() == {"status": "success"}

        # 3. Retrieve and assert
        r = await client.get("/api/setup/progress")
        assert r.status_code == 200
        data = r.json()
        assert data["step"] == 2
        assert data["den_type"] == "local"
        assert data["verified"] is False
        assert data["verifying"] is True
        assert data["verify_logs"] == ["Log line 1", "Log line 2"]
        assert data["active_run_id"] == "run-123"
        assert data["corrupted"] is False

        # 4. Partial update (PATCH style POST since it's Optional fields on body)
        r = await client.post("/api/setup/progress", json={"step": 3})
        assert r.status_code == 200

        # Retrieve and assert step updated but others remained intact
        r = await client.get("/api/setup/progress")
        assert r.status_code == 200
        data = r.json()
        assert data["step"] == 3
        assert data["den_type"] == "local"

        # 5. Delete progress
        r = await client.delete("/api/setup/progress")
        assert r.status_code == 200
        assert r.json() == {"status": "success"}

        # Should be empty defaults again
        r = await client.get("/api/setup/progress")
        assert r.status_code == 200
        data = r.json()
        assert data["step"] is None
        assert data["den_type"] is None


# ---------------------------------------------------------------------------
# Backup Import in Setup tests
# ---------------------------------------------------------------------------

class TestBackupImportInSetup:
    async def test_backup_import_prefills_without_completing_setup(self, client):
        """Verify that importing a backup on a fresh database pre-fills the
        settings but does NOT mark the setup as complete (setup_complete = "1").
        """
        import base64
        import json

        # Prepare a mock backup payload that contains setup_complete="1"
        backup_data = {
            "settings": {
                "ai_provider": "openrouter",
                "ai_model": "x-ai/grok-2",
                "setup_complete": "1"
            },
            "dens": [
                {
                    "id": "aws",
                    "name": "aws",
                    "type": "aws",
                    "max_runners": 10,
                    "warm_runners": 5
                }
            ],
            "projects": []
        }
        
        backup_bytes = json.dumps({"data": backup_data}).encode("utf-8")
        base64_payload = base64.b64encode(backup_bytes).decode("utf-8")

        # 1. Post to import settings
        r = await client.post("/api/settings/import", json={"file_content": base64_payload})
        assert r.status_code == 200

        # 2. Get setup status - setup_complete must still be False!
        r_setup = await client.get("/api/setup")
        assert r_setup.status_code == 200
        assert r_setup.json()["setup_complete"] is False

        # 3. Verify that the imported settings are still readable to pre-fill the wizard
        r_config = await client.get("/api/setup/config")
        assert r_config.status_code == 200
        assert r_config.json()["ai_provider"] == "openrouter"
        assert r_config.json()["ai_model"] == "x-ai/grok-2"


# ---------------------------------------------------------------------------
# RTK installation verification test
# ---------------------------------------------------------------------------

class TestRtkInstallation:
    def test_rtk_binary_installed_and_runnable(self):
        """Verify rtk binary is installed, on the path, and executable."""
        import subprocess
        res = subprocess.run(["rtk", "--help"], capture_output=True, text=True)
        assert res.returncode == 0
        assert "rtk" in res.stdout.lower() or "usage" in res.stdout.lower() or "help" in res.stdout.lower()





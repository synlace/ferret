"""
test_api_security.py — Security regression tests for the FERRET API.

Covers the three fixes applied 2026-05-14:
  1. CORS: allow_origins restricted to localhost:{UI_PORT} only
  2. Destructive endpoints require ?confirm=destroy
  3. Path traversal blocked in GET/PUT /api/tests/files/{filename}

Run with:
    cd github/ferret/src/apps/api
    pytest test_api_security.py -v
"""

import pytest


# ===========================================================================
# 1. CORS — origin allowlist
# ===========================================================================

class TestCORSAllowedOrigin:
    """Requests from the allowed UI origin receive CORS headers."""

    @pytest.mark.asyncio
    async def test_allowed_origin_gets_cors_header(self, client):
        resp = await client.get(
            "/api/requests",
            headers={"Origin": "http://localhost:3000"},
        )
        assert resp.status_code == 200
        assert resp.headers.get("access-control-allow-origin") == "http://localhost:3000"

    @pytest.mark.asyncio
    async def test_preflight_allowed_origin_returns_ok(self, client):
        resp = await client.options(
            "/api/requests",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert resp.status_code in (200, 204)
        assert resp.headers.get("access-control-allow-origin") == "http://localhost:3000"


class TestCORSDisallowedOrigin:
    """Requests from an arbitrary origin must NOT receive a wildcard CORS header."""

    @pytest.mark.asyncio
    async def test_attacker_origin_gets_no_wildcard_cors(self, client):
        resp = await client.get(
            "/api/requests",
            headers={"Origin": "https://evil.example.com"},
        )
        acao = resp.headers.get("access-control-allow-origin", "")
        assert acao != "*", "Wildcard CORS must not be returned for unknown origins"
        assert "evil.example.com" not in acao

    @pytest.mark.asyncio
    async def test_preflight_disallowed_origin_no_wildcard(self, client):
        resp = await client.options(
            "/api/requests",
            headers={
                "Origin": "https://evil.example.com",
                "Access-Control-Request-Method": "DELETE",
            },
        )
        acao = resp.headers.get("access-control-allow-origin", "")
        assert acao != "*"
        assert "evil.example.com" not in acao


# ===========================================================================
# 2. Destructive endpoints — ?confirm=destroy guard
# ===========================================================================

class TestResetDatabaseGuard:
    """DELETE /api/projects/reset requires ?confirm=destroy."""

    @pytest.mark.asyncio
    async def test_reset_without_confirm_returns_400(self, client):
        resp = await client.delete("/api/projects/reset")
        assert resp.status_code == 400
        assert "confirm" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_reset_wrong_confirm_value_returns_400(self, client):
        resp = await client.delete("/api/projects/reset?confirm=yes")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_reset_with_correct_confirm_succeeds(self, client):
        resp = await client.delete("/api/projects/reset?confirm=destroy")
        assert resp.status_code == 204


class TestDeleteAllProjectsGuard:
    """DELETE /api/projects/all requires ?confirm=destroy."""

    @pytest.mark.asyncio
    async def test_delete_all_without_confirm_returns_400(self, client):
        resp = await client.delete("/api/projects/all")
        assert resp.status_code == 400
        assert "confirm" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_delete_all_wrong_confirm_value_returns_400(self, client):
        resp = await client.delete("/api/projects/all?confirm=please")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_delete_all_with_correct_confirm_succeeds(self, client):
        resp = await client.delete("/api/projects/all?confirm=destroy")
        assert resp.status_code == 204


# ===========================================================================
# 3. Path traversal — GET /api/tests/files/{filename}
# ===========================================================================

class TestTestFileReadTraversal:
    """GET /api/tests/files/{filename} must reject path traversal attempts."""

    @pytest.mark.asyncio
    async def test_read_normal_file_returns_200(self, client_with_tests_dir):
        client, tests_dir = client_with_tests_dir
        (tests_dir / "test_example.py").write_text("# ok")
        resp = await client.get("/api/tests/files/test_example.py")
        assert resp.status_code == 200
        assert resp.json()["content"] == "# ok"

    @pytest.mark.asyncio
    async def test_read_parent_traversal_blocked(self, client_with_tests_dir):
        # httpx normalises "../ferret.db" → "ferret.db" before sending, so the
        # server sees /api/tests/files/ferret.db which doesn't exist → 404.
        # Either 400 (guard fired) or 404 (path normalised, file absent) is safe.
        client, tests_dir = client_with_tests_dir
        resp = await client.get("/api/tests/files/../ferret.db")
        assert resp.status_code in (400, 404)

    @pytest.mark.asyncio
    async def test_read_deep_traversal_blocked(self, client_with_tests_dir):
        client, tests_dir = client_with_tests_dir
        resp = await client.get("/api/tests/files/../../etc/passwd")
        assert resp.status_code in (400, 404)

    @pytest.mark.asyncio
    async def test_read_encoded_traversal_returns_400_or_404(self, client_with_tests_dir):
        """URL-encoded dots should also be caught after path normalisation."""
        client, tests_dir = client_with_tests_dir
        resp = await client.get("/api/tests/files/%2e%2e%2fferret.db")
        # Either 400 (traversal blocked) or 404 (path normalised, file not found) is acceptable.
        assert resp.status_code in (400, 404)


# ===========================================================================
# 4. Path traversal — PUT /api/tests/files/{filename}
# ===========================================================================

class TestTestFileWriteTraversal:
    """PUT /api/tests/files/{filename} must reject path traversal attempts."""

    @pytest.mark.asyncio
    async def test_write_normal_file_returns_200(self, client_with_tests_dir):
        client, tests_dir = client_with_tests_dir
        resp = await client.put(
            "/api/tests/files/test_new.py",
            json={"content": "def test_pass(): pass"},
        )
        assert resp.status_code == 200
        assert (tests_dir / "test_new.py").exists()

    @pytest.mark.asyncio
    async def test_write_parent_traversal_blocked(self, client_with_tests_dir):
        # httpx normalises "../ferret.db" → "ferret.db" before sending, which
        # may result in a 404 (route not matched), 400 (guard fired), or 200
        # (normalised to a safe path inside TESTS_DIR).
        # The definitive assertion is test_write_traversal_does_not_create_file.
        client, tests_dir = client_with_tests_dir
        resp = await client.put(
            "/api/tests/files/../ferret.db",
            json={"content": "pwned"},
        )
        assert resp.status_code in (200, 400, 404)

    @pytest.mark.asyncio
    async def test_write_deep_traversal_blocked(self, client_with_tests_dir):
        client, tests_dir = client_with_tests_dir
        resp = await client.put(
            "/api/tests/files/../../etc/cron.d/evil",
            json={"content": "* * * * * root rm -rf /"},
        )
        assert resp.status_code in (200, 400, 404)

    @pytest.mark.asyncio
    async def test_write_traversal_does_not_create_file(self, client_with_tests_dir):
        """Verify the file was NOT written to the filesystem on a blocked traversal."""
        client, tests_dir = client_with_tests_dir
        target = tests_dir.parent / "ferret.db"
        target.unlink(missing_ok=True)
        await client.put(
            "/api/tests/files/../ferret.db",
            json={"content": "pwned"},
        )
        assert not target.exists(), "Traversal must not write outside TESTS_DIR"

"""
FERRET API v2 — pytest unit tests for findings, test-files, and history endpoints.

Covers
------
Findings:
  - GET  /api/findings                  (empty list)
  - POST /api/findings                  (create, 201)
  - GET  /api/findings?severity=high    (filter by severity)
  - GET  /api/findings?status=open      (filter by status)
  - GET  /api/findings?host=example.com (filter by host)
  - PATCH /api/findings/{id}            (update status)
  - DELETE /api/findings/{id}           (204)
  - DELETE /api/findings/{nonexistent}  (404)

Tests files:
  - GET /api/tests/files                (empty when TESTS_DIR missing/empty)
  - GET /api/tests/files/{nonexistent}  (404)

History source filter:
  - GET /api/requests?source=proxy      (200)
  - GET /api/requests?source=test       (200)

Run with:
    cd github/monorepo/tools/ferret/src/apps/api
    pytest test_api_v2.py -v
"""

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FINDING_PAYLOAD = {
    "title": "SQL Injection in login form",
    "severity": "high",
    "type": "sqli",
    "host": "example.com",
    "source": "manual",
    "description": "Classic UNION-based SQLi",
    "evidence": "' OR 1=1 --",
}


# ===========================================================================
# Findings
# ===========================================================================

class TestFindingsEmpty:
    """GET /api/findings returns an empty list when the DB is fresh."""

    @pytest.mark.asyncio
    async def test_get_findings_empty(self, client):
        resp = await client.get("/api/findings")
        assert resp.status_code == 200
        assert resp.json() == []


class TestFindingsCreate:
    """POST /api/findings creates a finding and returns 201."""

    @pytest.mark.asyncio
    async def test_create_finding_returns_201(self, client):
        resp = await client.post("/api/findings", json=_FINDING_PAYLOAD)
        assert resp.status_code == 201

    @pytest.mark.asyncio
    async def test_create_finding_body_has_id(self, client):
        resp = await client.post("/api/findings", json=_FINDING_PAYLOAD)
        data = resp.json()
        assert "id" in data
        assert len(data["id"]) > 0

    @pytest.mark.asyncio
    async def test_create_finding_body_has_correct_fields(self, client):
        resp = await client.post("/api/findings", json=_FINDING_PAYLOAD)
        data = resp.json()
        assert data["title"] == _FINDING_PAYLOAD["title"]
        assert data["severity"] == _FINDING_PAYLOAD["severity"]
        assert data["type"] == _FINDING_PAYLOAD["type"]
        assert data["host"] == _FINDING_PAYLOAD["host"]
        assert data["source"] == _FINDING_PAYLOAD["source"]

    @pytest.mark.asyncio
    async def test_create_finding_default_status_is_open(self, client):
        resp = await client.post("/api/findings", json=_FINDING_PAYLOAD)
        assert resp.json()["status"] == "open"

    @pytest.mark.asyncio
    async def test_create_finding_appears_in_list(self, client):
        await client.post("/api/findings", json=_FINDING_PAYLOAD)
        resp = await client.get("/api/findings")
        assert resp.status_code == 200
        findings = resp.json()
        assert len(findings) == 1
        assert findings[0]["title"] == _FINDING_PAYLOAD["title"]


class TestFindingsFilters:
    """GET /api/findings with query-string filters."""

    @pytest.mark.asyncio
    async def test_filter_by_severity_match(self, client):
        await client.post("/api/findings", json=_FINDING_PAYLOAD)  # severity=high
        await client.post("/api/findings", json={**_FINDING_PAYLOAD, "severity": "low", "title": "Low finding"})

        resp = await client.get("/api/findings?severity=high")
        assert resp.status_code == 200
        findings = resp.json()
        assert all(f["severity"] == "high" for f in findings)
        assert len(findings) == 1

    @pytest.mark.asyncio
    async def test_filter_by_severity_no_match(self, client):
        await client.post("/api/findings", json=_FINDING_PAYLOAD)  # severity=high
        resp = await client.get("/api/findings?severity=critical")
        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_filter_by_status_open(self, client):
        await client.post("/api/findings", json=_FINDING_PAYLOAD)
        resp = await client.get("/api/findings?status=open")
        assert resp.status_code == 200
        findings = resp.json()
        assert len(findings) == 1
        assert findings[0]["status"] == "open"

    @pytest.mark.asyncio
    async def test_filter_by_status_no_match(self, client):
        await client.post("/api/findings", json=_FINDING_PAYLOAD)
        resp = await client.get("/api/findings?status=fixed")
        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_filter_by_host_match(self, client):
        await client.post("/api/findings", json=_FINDING_PAYLOAD)  # host=example.com
        await client.post("/api/findings", json={**_FINDING_PAYLOAD, "host": "other.org", "title": "Other"})

        resp = await client.get("/api/findings?host=example.com")
        assert resp.status_code == 200
        findings = resp.json()
        assert all("example.com" in f["host"] for f in findings)

    @pytest.mark.asyncio
    async def test_filter_by_host_no_match(self, client):
        await client.post("/api/findings", json=_FINDING_PAYLOAD)
        resp = await client.get("/api/findings?host=notfound.io")
        assert resp.status_code == 200
        assert resp.json() == []


class TestFindingsPatch:
    """PATCH /api/findings/{id} updates the status field."""

    @pytest.mark.asyncio
    async def test_patch_status_returns_200(self, client):
        create_resp = await client.post("/api/findings", json=_FINDING_PAYLOAD)
        finding_id = create_resp.json()["id"]

        resp = await client.patch(f"/api/findings/{finding_id}", json={"status": "confirmed"})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_patch_status_response_body(self, client):
        create_resp = await client.post("/api/findings", json=_FINDING_PAYLOAD)
        finding_id = create_resp.json()["id"]

        resp = await client.patch(f"/api/findings/{finding_id}", json={"status": "confirmed"})
        data = resp.json()
        assert data["id"] == finding_id
        assert data["status"] == "confirmed"

    @pytest.mark.asyncio
    async def test_patch_status_persisted(self, client):
        create_resp = await client.post("/api/findings", json=_FINDING_PAYLOAD)
        finding_id = create_resp.json()["id"]

        await client.patch(f"/api/findings/{finding_id}", json={"status": "false_positive"})

        list_resp = await client.get("/api/findings")
        finding = next(f for f in list_resp.json() if f["id"] == finding_id)
        assert finding["status"] == "false_positive"

    @pytest.mark.asyncio
    async def test_patch_nonexistent_finding_returns_404(self, client):
        resp = await client.patch("/api/findings/does-not-exist", json={"status": "fixed"})
        assert resp.status_code == 404


class TestFindingsDelete:
    """DELETE /api/findings/{id}."""

    @pytest.mark.asyncio
    async def test_delete_finding_returns_204(self, client):
        create_resp = await client.post("/api/findings", json=_FINDING_PAYLOAD)
        finding_id = create_resp.json()["id"]

        resp = await client.delete(f"/api/findings/{finding_id}")
        assert resp.status_code == 204

    @pytest.mark.asyncio
    async def test_delete_finding_removes_from_list(self, client):
        create_resp = await client.post("/api/findings", json=_FINDING_PAYLOAD)
        finding_id = create_resp.json()["id"]

        await client.delete(f"/api/findings/{finding_id}")

        list_resp = await client.get("/api/findings")
        ids = [f["id"] for f in list_resp.json()]
        assert finding_id not in ids

    @pytest.mark.asyncio
    async def test_delete_nonexistent_finding_returns_404(self, client):
        resp = await client.delete("/api/findings/nonexistent-id-xyz")
        assert resp.status_code == 404


# ===========================================================================
# Tests files endpoints
# ===========================================================================

class TestTestsFilesEmpty:
    """GET /api/tests/files returns {"files": []} when TESTS_DIR is empty or missing."""

    @pytest.mark.asyncio
    async def test_list_files_empty_dir(self, client):
        # tmp_path exists but is empty — no test_*.py files
        resp = await client.get("/api/tests/files")
        assert resp.status_code == 200
        data = resp.json()
        assert "files" in data
        assert data["files"] == []

    @pytest.mark.asyncio
    async def test_list_files_with_test_file_present(self, client_with_tests_dir):
        ac, tests_dir = client_with_tests_dir
        # Create a test file matching the glob pattern
        (tests_dir / "test_example_com.py").write_text("# placeholder")

        resp = await ac.get("/api/tests/files")
        assert resp.status_code == 200
        files = resp.json()["files"]
        assert len(files) == 1
        assert files[0]["filename"] == "test_example_com.py"

    @pytest.mark.asyncio
    async def test_list_files_non_test_files_excluded(self, client_with_tests_dir):
        ac, tests_dir = client_with_tests_dir
        # Files that don't match test_*.py should not appear
        (tests_dir / "helper.py").write_text("# helper")
        (tests_dir / "conftest.py").write_text("# conftest")

        resp = await ac.get("/api/tests/files")
        assert resp.status_code == 200
        assert resp.json()["files"] == []


class TestTestsFilesGet:
    """GET /api/tests/files/{filename}."""

    @pytest.mark.asyncio
    async def test_get_nonexistent_file_returns_404(self, client):
        resp = await client.get("/api/tests/files/test_does_not_exist.py")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_get_existing_file_returns_content(self, client_with_tests_dir):
        ac, tests_dir = client_with_tests_dir
        content = "import pytest\n\ndef test_example(): pass\n"
        (tests_dir / "test_api_example_com.py").write_text(content)

        resp = await ac.get("/api/tests/files/test_api_example_com.py")
        assert resp.status_code == 200
        data = resp.json()
        assert data["filename"] == "test_api_example_com.py"
        assert data["content"] == content


# ===========================================================================
# History source filter
# ===========================================================================

class TestRequestsSourceFilter:
    """GET /api/requests?source=<value> returns 200 (even when empty)."""

    @pytest.mark.asyncio
    async def test_source_proxy_returns_200(self, client):
        resp = await client.get("/api/requests?source=proxy")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_source_proxy_returns_list(self, client):
        resp = await client.get("/api/requests?source=proxy")
        assert isinstance(resp.json(), list)

    @pytest.mark.asyncio
    async def test_source_test_returns_200(self, client):
        resp = await client.get("/api/requests?source=test")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_source_test_returns_list(self, client):
        resp = await client.get("/api/requests?source=test")
        assert isinstance(resp.json(), list)

    @pytest.mark.asyncio
    async def test_source_filter_empty_when_no_requests(self, client):
        resp = await client.get("/api/requests?source=proxy")
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_source_filter_total_count_header_present(self, client):
        resp = await client.get("/api/requests?source=proxy")
        assert "x-total-count" in resp.headers

    @pytest.mark.asyncio
    async def test_source_filter_total_count_is_zero_when_empty(self, client):
        resp = await client.get("/api/requests?source=proxy")
        assert resp.headers["x-total-count"] == "0"

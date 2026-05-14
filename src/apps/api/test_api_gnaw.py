"""
FERRET API — pytest unit tests for the Gnaw feature.

Covers
------
POST /api/gnaw/send — real HTTP response fix:
  1. Stores the request in settings under 'gnaw_current_request'
  2. Overwrites the previously stored request on a second call
  3. Returns the actual HTTP response: status_code, response_headers,
     response_body, response_time
  4. Returns 502 on a network-level error (e.g. DNS failure)
  5. Returns the target's 4xx/5xx status inside the response body
     (the gnaw endpoint itself returns 200 — it is a proxy, not a forwarder)

GET /api/gnaw/current:
  6. Returns the last request sent via POST /api/gnaw/send
  7. Returns 404 when no request has been sent yet

Run with:
    cd github/monorepo/tools/ferret/src/apps/api
    pytest test_api_gnaw.py -v
"""

import json
import uuid
import pytest
import httpx
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

# conftest.py provides: client, mem_db fixtures


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_request_payload(
    host: str = "example.com",
    method: str = "GET",
    path: str = "/api/test",
    url: str | None = None,
    body: str | None = None,
) -> dict:
    """Return a minimal HttpRequest-compatible dict."""
    if url is None:
        url = f"https://{host}{path}"
    return {
        "id": uuid.uuid4().hex,
        "timestamp": datetime.utcnow().isoformat(),
        "method": method,
        "url": url,
        "host": host,
        "path": path,
        "headers": {"host": host, "content-type": "application/json"},
        "body": body,
        "content_length": len(body) if body else 0,
        "intercepted": False,
        "modified": False,
        "source": "gnaw",
    }


def _make_httpx_response(
    status_code: int = 200,
    body: str = '{"ok": true}',
    headers: dict | None = None,
    elapsed_ms: float = 42.0,
) -> MagicMock:
    """Return a mock httpx.Response for the gnaw's outbound HTTP call."""
    mock = MagicMock()
    mock.status_code = status_code
    mock.text = body
    mock.headers = headers or {"content-type": "application/json"}
    mock.elapsed = MagicMock()
    mock.elapsed.total_seconds.return_value = elapsed_ms / 1000.0
    return mock


def _make_async_client_ctx(mock_response: MagicMock):
    """
    Return a replacement for httpx.AsyncClient that works as an async context manager.

    The endpoint does:
        async with httpx.AsyncClient(...) as client:
            resp = await client.request(...)

    So we need:
        httpx.AsyncClient(...)  → context-manager mock
        async with ...          → yields inner mock
        inner.request(...)      → returns mock_response
    """
    inner = MagicMock()
    inner.request = AsyncMock(return_value=mock_response)
    inner.post = AsyncMock(return_value=mock_response)

    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=inner)
    cm.__aexit__ = AsyncMock(return_value=False)

    cls_mock = MagicMock(return_value=cm)
    return cls_mock, inner


def _make_async_client_ctx_raising(exc: Exception):
    """Like _make_async_client_ctx but inner.request() raises exc."""
    inner = MagicMock()
    inner.request = AsyncMock(side_effect=exc)
    inner.post = AsyncMock(side_effect=exc)

    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=inner)
    cm.__aexit__ = AsyncMock(return_value=False)

    cls_mock = MagicMock(return_value=cm)
    return cls_mock, inner


# ---------------------------------------------------------------------------
# 1. POST /api/gnaw/send — stores the request and returns the response
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_send_to_gnaw_stores_request(client, mem_db):
    """
    POST /api/gnaw/send must persist the request in the settings table
    under the key 'gnaw_current_request'.
    """
    payload = _make_request_payload(host="target.example.com", method="POST", path="/login")
    cls_mock, _ = _make_async_client_ctx(_make_httpx_response())

    with patch("routers.proxy.httpx.AsyncClient", cls_mock):
        resp = await client.post("/api/gnaw/send", json=payload)

    assert resp.status_code == 200

    stored_raw = await mem_db.get_setting("gnaw_current_request")
    assert stored_raw is not None, "gnaw_current_request setting must be set after POST"

    stored = json.loads(stored_raw)
    assert stored["host"] == "target.example.com"
    assert stored["method"] == "POST"
    assert stored["path"] == "/login"


@pytest.mark.asyncio
async def test_send_to_gnaw_overwrites_previous(client, mem_db):
    """
    A second POST /api/gnaw/send must overwrite the previously stored request.
    """
    first_payload = _make_request_payload(host="first.example.com", path="/first")
    second_payload = _make_request_payload(host="second.example.com", path="/second")
    cls_mock, _ = _make_async_client_ctx(_make_httpx_response())

    with patch("routers.proxy.httpx.AsyncClient", cls_mock):
        await client.post("/api/gnaw/send", json=first_payload)
        await client.post("/api/gnaw/send", json=second_payload)

    stored_raw = await mem_db.get_setting("gnaw_current_request")
    stored = json.loads(stored_raw)
    assert stored["host"] == "second.example.com"
    assert stored["path"] == "/second"


# ---------------------------------------------------------------------------
# 2. POST /api/gnaw/send — returns the real HTTP response fields
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_send_returns_status_code(client):
    """The response must include the HTTP status code from the target server."""
    payload = _make_request_payload()
    cls_mock, _ = _make_async_client_ctx(_make_httpx_response(status_code=200))

    with patch("routers.proxy.httpx.AsyncClient", cls_mock):
        resp = await client.post("/api/gnaw/send", json=payload)

    assert resp.status_code == 200
    data = resp.json()
    assert "status_code" in data
    assert data["status_code"] == 200


@pytest.mark.asyncio
async def test_send_returns_response_body(client):
    """The response must include the body text from the target server."""
    payload = _make_request_payload()
    cls_mock, _ = _make_async_client_ctx(_make_httpx_response(body='{"hello": "world"}'))

    with patch("routers.proxy.httpx.AsyncClient", cls_mock):
        resp = await client.post("/api/gnaw/send", json=payload)

    data = resp.json()
    assert "response_body" in data
    assert data["response_body"] == '{"hello": "world"}'


@pytest.mark.asyncio
async def test_send_returns_response_headers(client):
    """The response must include the headers returned by the target server."""
    payload = _make_request_payload()
    cls_mock, _ = _make_async_client_ctx(
        _make_httpx_response(headers={"content-type": "application/json", "x-custom": "yes"})
    )

    with patch("routers.proxy.httpx.AsyncClient", cls_mock):
        resp = await client.post("/api/gnaw/send", json=payload)

    data = resp.json()
    assert "response_headers" in data
    assert data["response_headers"]["content-type"] == "application/json"


@pytest.mark.asyncio
async def test_send_returns_elapsed_ms(client):
    """The response must include the round-trip time in milliseconds."""
    payload = _make_request_payload()
    cls_mock, _ = _make_async_client_ctx(_make_httpx_response(elapsed_ms=123.0))

    with patch("routers.proxy.httpx.AsyncClient", cls_mock):
        resp = await client.post("/api/gnaw/send", json=payload)

    data = resp.json()
    assert "response_time" in data
    assert data["response_time"] == 123


# ---------------------------------------------------------------------------
# 3. POST /api/gnaw/send — error handling
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_send_network_error_returns_502(client):
    """A network-level error (e.g. DNS failure) must return 502, not 500."""
    payload = _make_request_payload(
        host="does-not-exist.invalid",
        url="http://does-not-exist.invalid/",
    )
    cls_mock, _ = _make_async_client_ctx_raising(
        httpx.ConnectError("Name or service not known")
    )

    with patch("routers.proxy.httpx.AsyncClient", cls_mock):
        resp = await client.post("/api/gnaw/send", json=payload)

    assert resp.status_code == 502
    assert "detail" in resp.json()


@pytest.mark.asyncio
async def test_send_4xx_target_response_is_returned_not_raised(client):
    """
    A 4xx response from the target server is a valid HTTP response.
    The gnaw must return it to the client rather than raising an error.
    The gnaw endpoint itself returns 200; the target status is in the body.
    """
    payload = _make_request_payload()
    cls_mock, _ = _make_async_client_ctx(_make_httpx_response(status_code=404, body="Not Found"))

    with patch("routers.proxy.httpx.AsyncClient", cls_mock):
        resp = await client.post("/api/gnaw/send", json=payload)

    assert resp.status_code == 200  # the gnaw endpoint itself succeeds
    data = resp.json()
    assert data["status_code"] == 404
    assert data["response_body"] == "Not Found"


# ---------------------------------------------------------------------------
# 4. GET /api/gnaw/current — returns the last sent request
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_gnaw_current_returns_last_sent(client, mem_db):
    """
    After POST /api/gnaw/send, GET /api/gnaw/current must return
    the same request as a valid HttpRequest object.
    """
    payload = _make_request_payload(host="api.example.com", method="PUT", path="/resource/42")
    cls_mock, _ = _make_async_client_ctx(_make_httpx_response())

    with patch("routers.proxy.httpx.AsyncClient", cls_mock):
        post_resp = await client.post("/api/gnaw/send", json=payload)
    assert post_resp.status_code == 200

    get_resp = await client.get("/api/gnaw/current")
    assert get_resp.status_code == 200

    data = get_resp.json()
    assert data["host"] == "api.example.com"
    assert data["method"] == "PUT"
    assert data["path"] == "/resource/42"
    assert data["url"] == "https://api.example.com/resource/42"


@pytest.mark.asyncio
async def test_get_gnaw_current_reflects_latest_send(client, mem_db):
    """
    GET /api/gnaw/current must always reflect the most recent POST.
    """
    cls_mock, _ = _make_async_client_ctx(_make_httpx_response())

    with patch("routers.proxy.httpx.AsyncClient", cls_mock):
        for i in range(3):
            payload = _make_request_payload(host=f"host{i}.example.com", path=f"/path/{i}")
            await client.post("/api/gnaw/send", json=payload)

    get_resp = await client.get("/api/gnaw/current")
    assert get_resp.status_code == 200
    data = get_resp.json()
    assert data["host"] == "host2.example.com"
    assert data["path"] == "/path/2"


# ---------------------------------------------------------------------------
# 5. GET /api/gnaw/current — returns 404 when no request has been sent
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_gnaw_current_404_when_empty(client, mem_db):
    """
    GET /api/gnaw/current must return 404 when no request has ever been
    sent via POST /api/gnaw/send (i.e. the settings key is absent).
    """
    stored = await mem_db.get_setting("gnaw_current_request")
    assert stored is None, "Precondition: settings table must be empty for this test"

    resp = await client.get("/api/gnaw/current")
    assert resp.status_code == 404
    assert "detail" in resp.json()


# ---------------------------------------------------------------------------
# Gnaw Tabs — CRUD endpoints
# ---------------------------------------------------------------------------

class TestGnawTabsCRUD:
    """
    Tests for the project-scoped gnaw tab endpoints:

    GET    /api/gnaw/tabs           — list tabs
    POST   /api/gnaw/tabs           — create tab
    GET    /api/gnaw/tabs/{id}      — get single tab
    PUT    /api/gnaw/tabs/{id}      — update tab
    DELETE /api/gnaw/tabs/{id}      — delete tab
    POST   /api/gnaw/tabs/{id}/send — send request for tab
    """

    @pytest.mark.asyncio
    async def test_list_tabs_empty(self, client, mem_db):
        """GET /api/gnaw/tabs returns an empty list when no tabs exist."""
        resp = await client.get("/api/gnaw/tabs")
        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_create_tab_minimal(self, client, mem_db):
        """POST /api/gnaw/tabs creates a tab and returns 201 with the tab data."""
        resp = await client.post("/api/gnaw/tabs", json={"label": "GET example.com"})
        assert resp.status_code == 201
        data = resp.json()
        assert "id" in data
        assert data["label"] == "GET example.com"
        assert data["project_id"] == "temp"
        assert data["raw_request"] is None
        assert data["response"] is None

    @pytest.mark.asyncio
    async def test_create_tab_with_raw_request(self, client, mem_db):
        """POST /api/gnaw/tabs stores the raw_request field."""
        raw = "GET / HTTP/1.1\nHost: example.com\n\n"
        resp = await client.post("/api/gnaw/tabs", json={"label": "GET example.com", "raw_request": raw})
        assert resp.status_code == 201
        data = resp.json()
        assert data["raw_request"] == raw

    @pytest.mark.asyncio
    async def test_list_tabs_after_create(self, client, mem_db):
        """GET /api/gnaw/tabs returns all created tabs."""
        await client.post("/api/gnaw/tabs", json={"label": "Tab A"})
        await client.post("/api/gnaw/tabs", json={"label": "Tab B"})
        resp = await client.get("/api/gnaw/tabs")
        assert resp.status_code == 200
        labels = [t["label"] for t in resp.json()]
        assert "Tab A" in labels
        assert "Tab B" in labels

    @pytest.mark.asyncio
    async def test_get_tab_by_id(self, client, mem_db):
        """GET /api/gnaw/tabs/{id} returns the full tab including raw_request."""
        raw = "POST /api HTTP/1.1\nHost: api.example.com\n\n{}"
        create_resp = await client.post("/api/gnaw/tabs", json={"label": "POST api.example.com", "raw_request": raw})
        tab_id = create_resp.json()["id"]

        resp = await client.get(f"/api/gnaw/tabs/{tab_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == tab_id
        assert data["raw_request"] == raw

    @pytest.mark.asyncio
    async def test_get_tab_404_unknown_id(self, client, mem_db):
        """GET /api/gnaw/tabs/{id} returns 404 for an unknown tab ID."""
        resp = await client.get("/api/gnaw/tabs/nonexistent-id")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_update_tab(self, client, mem_db):
        """PUT /api/gnaw/tabs/{id} updates label and raw_request."""
        create_resp = await client.post("/api/gnaw/tabs", json={"label": "Old Label"})
        tab_id = create_resp.json()["id"]

        new_raw = "DELETE /resource HTTP/1.1\nHost: example.com\n\n"
        resp = await client.put(f"/api/gnaw/tabs/{tab_id}", json={"label": "New Label", "raw_request": new_raw})
        assert resp.status_code == 200
        assert resp.json()["ok"] is True

        # Verify the update persisted
        get_resp = await client.get(f"/api/gnaw/tabs/{tab_id}")
        data = get_resp.json()
        assert data["label"] == "New Label"
        assert data["raw_request"] == new_raw

    @pytest.mark.asyncio
    async def test_update_tab_404_unknown_id(self, client, mem_db):
        """PUT /api/gnaw/tabs/{id} returns 404 for an unknown tab ID."""
        resp = await client.put("/api/gnaw/tabs/nonexistent-id", json={"label": "X"})
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_tab(self, client, mem_db):
        """DELETE /api/gnaw/tabs/{id} removes the tab; subsequent GET returns 404."""
        create_resp = await client.post("/api/gnaw/tabs", json={"label": "To Delete"})
        tab_id = create_resp.json()["id"]

        del_resp = await client.delete(f"/api/gnaw/tabs/{tab_id}")
        assert del_resp.status_code == 204

        get_resp = await client.get(f"/api/gnaw/tabs/{tab_id}")
        assert get_resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_tab_404_unknown_id(self, client, mem_db):
        """DELETE /api/gnaw/tabs/{id} returns 404 for an unknown tab ID."""
        resp = await client.delete("/api/gnaw/tabs/nonexistent-id")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_tabs_are_project_scoped(self, client, mem_db):
        """Tabs created in project 'temp' are not visible when active project changes."""
        # Create a tab in the default 'temp' project
        await client.post("/api/gnaw/tabs", json={"label": "Temp Tab"})

        # Switch active project
        await mem_db.set_setting("active_project_id", "other-project")

        # List should be empty for the new project
        resp = await client.get("/api/gnaw/tabs")
        assert resp.status_code == 200
        assert resp.json() == []

        # Switch back
        await mem_db.set_setting("active_project_id", "temp")
        resp2 = await client.get("/api/gnaw/tabs")
        assert any(t["label"] == "Temp Tab" for t in resp2.json())

    @pytest.mark.asyncio
    async def test_send_tab_stores_response(self, client, mem_db):
        """POST /api/gnaw/tabs/{id}/send sends the request and persists the response."""
        raw = "GET / HTTP/1.1\nHost: example.com\n\n"
        create_resp = await client.post("/api/gnaw/tabs", json={"label": "GET example.com", "raw_request": raw})
        tab_id = create_resp.json()["id"]

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = '{"ok": true}'
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.elapsed = MagicMock()
        mock_resp.elapsed.total_seconds.return_value = 0.042

        mock_client = MagicMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.request = AsyncMock(return_value=mock_resp)

        payload = _make_request_payload(host="example.com", method="GET", path="/", url="https://example.com/")

        with patch("routers.proxy.httpx.AsyncClient", return_value=mock_client):
            resp = await client.post(f"/api/gnaw/tabs/{tab_id}/send", json=payload)

        assert resp.status_code == 200
        data = resp.json()
        assert data["status_code"] == 200
        assert data["response_body"] == '{"ok": true}'

        # Verify response was persisted on the tab
        get_resp = await client.get(f"/api/gnaw/tabs/{tab_id}")
        tab_data = get_resp.json()
        assert tab_data["response"] is not None
        assert tab_data["response"]["status_code"] == 200

    @pytest.mark.asyncio
    async def test_send_tab_404_unknown_id(self, client, mem_db):
        """POST /api/gnaw/tabs/{id}/send returns 404 for an unknown tab ID."""
        payload = _make_request_payload()
        resp = await client.post("/api/gnaw/tabs/nonexistent-id/send", json=payload)
        assert resp.status_code == 404

"""
FERRET API — pytest unit tests for the Snare intercept feature.

Covers
------
GET  /api/snare/rules                          — list rules (empty by default)
POST /api/snare/rules                          — add a rule
DELETE /api/snare/rules/{id}                   — delete a rule
POST /api/snare/start                          — enable snare
POST /api/snare/stop                           — disable snare
GET  /api/snare/intercepted                    — list pending intercepted requests
POST /api/snare/intercepted/{id}/forward       — forward (with optional modification)
POST /api/snare/intercepted/{id}/drop          — drop/kill
_should_snare logic                            — catch-all when no rules; rule matching

Run with:
    cd github/monorepo/tools/ferret/src/apps/api
    pytest test_api_snare.py -v
"""

import uuid
import pytest
from unittest.mock import AsyncMock, MagicMock
from datetime import datetime

# conftest.py provides: client, mem_db fixtures


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_rule(
    name: str = "Test Rule",
    host_pattern: str | None = r"example\.com",
    path_pattern: str | None = None,
    method: str | None = None,
    enabled: bool = True,
) -> dict:
    """Return a minimal SnareRule-compatible dict."""
    return {
        "id": str(uuid.uuid4()),
        "name": name,
        "enabled": enabled,
        "method": method,
        "host_pattern": host_pattern,
        "path_pattern": path_pattern,
        "header_filters": None,
        "body_pattern": None,
        "action": "snare",
    }


def _make_intercepted_request(
    request_id: str | None = None,
    method: str = "GET",
    host: str = "example.com",
    path: str = "/api/secret",
) -> dict:
    """Return a minimal intercepted HttpRequest-compatible dict."""
    return {
        "id": request_id or str(uuid.uuid4()),
        "timestamp": datetime.utcnow().isoformat(),
        "method": method,
        "url": f"https://{host}{path}",
        "host": host,
        "path": path,
        "query_params": None,
        "headers": {"host": host, "user-agent": "test"},
        "body": None,
        "content_type": None,
        "content_length": 0,
        "status_code": None,
        "response_headers": None,
        "response_body": None,
        "response_time": None,
        "response_size": None,
        "client_ip": "127.0.0.1",
        "server_ip": None,
        "tls_version": None,
        "intercepted": True,
        "modified": False,
        "annotation": None,
        "source": "proxy",
    }


# ---------------------------------------------------------------------------
# Snare rules — GET /api/snare/rules
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_snare_rules_empty(client):
    """GET /api/snare/rules returns an empty list when no rules are configured."""
    resp = await client.get("/api/snare/rules")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_get_snare_rules_returns_configured_rules(client):
    """GET /api/snare/rules returns whatever the manager reports."""
    import deps
    rule = _make_rule(name="My Rule")
    # Rebuild the mock to return a rule
    from models import SnareRule
    snare_rule = SnareRule(**rule)
    deps.mitm_manager.get_snare_rules = AsyncMock(return_value=[snare_rule])

    resp = await client.get("/api/snare/rules")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["name"] == "My Rule"


# ---------------------------------------------------------------------------
# Snare rules — POST /api/snare/rules
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_add_snare_rule_returns_200(client):
    """POST /api/snare/rules accepts a valid rule and returns 200."""
    rule = _make_rule(name="Intercept Login", host_pattern=r"api\.example\.com", path_pattern=r"/login")
    resp = await client.post("/api/snare/rules", json=rule)
    assert resp.status_code == 200
    assert resp.json()["message"] == "Snare rule added successfully"


@pytest.mark.asyncio
async def test_add_snare_rule_calls_manager(client):
    """POST /api/snare/rules delegates to mitm_manager.add_snare_rule."""
    import deps
    rule = _make_rule(name="Capture POST")
    resp = await client.post("/api/snare/rules", json=rule)
    assert resp.status_code == 200
    deps.mitm_manager.add_snare_rule.assert_called_once()


@pytest.mark.asyncio
async def test_add_snare_rule_minimal_fields(client):
    """POST /api/snare/rules works with only required fields (id, name, enabled, action)."""
    rule = {
        "id": str(uuid.uuid4()),
        "name": "Minimal Rule",
        "enabled": True,
        "action": "snare",
    }
    resp = await client.post("/api/snare/rules", json=rule)
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Snare rules — DELETE /api/snare/rules/{id}
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_snare_rule_returns_200(client):
    """DELETE /api/snare/rules/{id} returns 200 with a success message."""
    rule_id = str(uuid.uuid4())
    resp = await client.delete(f"/api/snare/rules/{rule_id}")
    assert resp.status_code == 200
    assert resp.json()["message"] == "Snare rule deleted successfully"


@pytest.mark.asyncio
async def test_delete_snare_rule_calls_manager(client):
    """DELETE /api/snare/rules/{id} delegates to mitm_manager.delete_snare_rule."""
    import deps
    rule_id = str(uuid.uuid4())
    resp = await client.delete(f"/api/snare/rules/{rule_id}")
    assert resp.status_code == 200
    deps.mitm_manager.delete_snare_rule.assert_called_once_with(rule_id)


# ---------------------------------------------------------------------------
# Snare start / stop
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_start_snare_returns_200(client):
    """POST /api/snare/start returns 200 with a success message."""
    resp = await client.post("/api/snare/start")
    assert resp.status_code == 200
    assert resp.json()["message"] == "Snare started successfully"


@pytest.mark.asyncio
async def test_start_snare_calls_manager(client):
    """POST /api/snare/start delegates to mitm_manager.start_snare."""
    import deps
    resp = await client.post("/api/snare/start")
    assert resp.status_code == 200
    deps.mitm_manager.start_snare.assert_called_once()


@pytest.mark.asyncio
async def test_stop_snare_returns_200(client):
    """POST /api/snare/stop returns 200 with a success message."""
    resp = await client.post("/api/snare/stop")
    assert resp.status_code == 200
    assert resp.json()["message"] == "Snare stopped successfully"


@pytest.mark.asyncio
async def test_stop_snare_calls_manager(client):
    """POST /api/snare/stop delegates to mitm_manager.stop_snare."""
    import deps
    resp = await client.post("/api/snare/stop")
    assert resp.status_code == 200
    deps.mitm_manager.stop_snare.assert_called_once()


# ---------------------------------------------------------------------------
# GET /api/snare/intercepted — list pending intercepted requests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_intercepted_empty(client):
    """GET /api/snare/intercepted returns an empty list when nothing is intercepted."""
    import deps
    deps.mitm_manager.list_intercepted = AsyncMock(return_value=[])

    resp = await client.get("/api/snare/intercepted")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_intercepted_returns_pending_requests(client):
    """GET /api/snare/intercepted returns all pending intercepted requests."""
    import deps
    req1 = _make_intercepted_request(method="GET", host="example.com", path="/api/users")
    req2 = _make_intercepted_request(method="POST", host="example.com", path="/api/login")
    deps.mitm_manager.list_intercepted = AsyncMock(return_value=[req1, req2])

    resp = await client.get("/api/snare/intercepted")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    methods = {r["method"] for r in data}
    assert "GET" in methods
    assert "POST" in methods


@pytest.mark.asyncio
async def test_list_intercepted_includes_required_fields(client):
    """Each intercepted request must include id, method, url, host, path."""
    import deps
    req = _make_intercepted_request(method="PUT", host="api.example.com", path="/resource/1")
    deps.mitm_manager.list_intercepted = AsyncMock(return_value=[req])

    resp = await client.get("/api/snare/intercepted")
    assert resp.status_code == 200
    item = resp.json()[0]
    assert "id" in item
    assert item["method"] == "PUT"
    assert item["host"] == "api.example.com"
    assert item["path"] == "/resource/1"
    assert "url" in item


@pytest.mark.asyncio
async def test_list_intercepted_calls_manager(client):
    """GET /api/snare/intercepted delegates to mitm_manager.list_intercepted."""
    import deps
    deps.mitm_manager.list_intercepted = AsyncMock(return_value=[])

    resp = await client.get("/api/snare/intercepted")
    assert resp.status_code == 200
    deps.mitm_manager.list_intercepted.assert_called_once()


# ---------------------------------------------------------------------------
# POST /api/snare/intercepted/{id}/forward
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_forward_intercepted_returns_200(client):
    """POST /api/snare/intercepted/{id}/forward returns 200 when request is found."""
    import deps
    request_id = str(uuid.uuid4())
    deps.mitm_manager.forward_intercepted = AsyncMock(return_value={"forwarded": True})

    resp = await client.post(
        f"/api/snare/intercepted/{request_id}/forward",
        json={"raw_request": None},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["forwarded"] is True


@pytest.mark.asyncio
async def test_forward_intercepted_returns_only_forwarded_flag(client):
    """POST /api/snare/intercepted/{id}/forward returns only {forwarded: true} — response comes via WS."""
    import deps
    request_id = str(uuid.uuid4())
    deps.mitm_manager.forward_intercepted = AsyncMock(return_value={"forwarded": True})

    resp = await client.post(
        f"/api/snare/intercepted/{request_id}/forward",
        json={},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["forwarded"] is True
    # No inline response data — it arrives via WebSocket snare_response_ready
    assert "status_code" not in data
    assert "response_body" not in data


@pytest.mark.asyncio
async def test_forward_intercepted_404_when_not_found(client):
    """POST /api/snare/intercepted/{id}/forward returns 404 when request is not found."""
    import deps
    deps.mitm_manager.forward_intercepted = AsyncMock(return_value={"forwarded": False})

    resp = await client.post(
        f"/api/snare/intercepted/{uuid.uuid4()}/forward",
        json={"raw_request": None},
    )
    assert resp.status_code == 404
    assert "detail" in resp.json()


@pytest.mark.asyncio
async def test_forward_intercepted_passes_raw_request(client):
    """POST /api/snare/intercepted/{id}/forward passes the raw_request to the manager."""
    import deps
    request_id = str(uuid.uuid4())
    deps.mitm_manager.forward_intercepted = AsyncMock(return_value={"forwarded": True})

    raw = "GET /modified HTTP/1.1\nHost: example.com\n\n"
    resp = await client.post(
        f"/api/snare/intercepted/{request_id}/forward",
        json={"raw_request": raw},
    )
    assert resp.status_code == 200
    deps.mitm_manager.forward_intercepted.assert_called_once_with(request_id, raw)


@pytest.mark.asyncio
async def test_forward_intercepted_without_modification(client):
    """POST /api/snare/intercepted/{id}/forward works with no raw_request (forward as-is)."""
    import deps
    request_id = str(uuid.uuid4())
    deps.mitm_manager.forward_intercepted = AsyncMock(return_value={"forwarded": True})

    resp = await client.post(
        f"/api/snare/intercepted/{request_id}/forward",
        json={},
    )
    assert resp.status_code == 200
    deps.mitm_manager.forward_intercepted.assert_called_once_with(request_id, None)


@pytest.mark.asyncio
async def test_forward_intercepted_client_disconnected_returns_200_with_flag(client):
    """
    POST /api/snare/intercepted/{id}/forward returns 200 with client_disconnected=True
    when the manager detects the client TCP connection is already closed.
    The UI uses this flag to clean up instead of waiting for snare_response_ready.
    """
    import deps
    request_id = str(uuid.uuid4())
    deps.mitm_manager.forward_intercepted = AsyncMock(
        return_value={"forwarded": True, "client_disconnected": True}
    )

    resp = await client.post(
        f"/api/snare/intercepted/{request_id}/forward",
        json={},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["forwarded"] is True
    assert data["client_disconnected"] is True



@pytest.mark.asyncio
async def test_forward_intercepted_calls_manager_with_correct_id(client):
    """POST /api/snare/intercepted/{id}/forward passes the correct request_id."""
    import deps
    request_id = str(uuid.uuid4())
    deps.mitm_manager.forward_intercepted = AsyncMock(return_value={"forwarded": True})

    await client.post(f"/api/snare/intercepted/{request_id}/forward", json={})
    call_args = deps.mitm_manager.forward_intercepted.call_args
    assert call_args[0][0] == request_id


# ---------------------------------------------------------------------------
# POST /api/snare/intercepted/{id}/drop
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_drop_intercepted_returns_200(client):
    """POST /api/snare/intercepted/{id}/drop returns 200 when request is found."""
    import deps
    request_id = str(uuid.uuid4())
    deps.mitm_manager.drop_intercepted = AsyncMock(return_value=True)

    resp = await client.post(f"/api/snare/intercepted/{request_id}/drop")
    assert resp.status_code == 200
    assert resp.json()["message"] == "Request dropped"


@pytest.mark.asyncio
async def test_drop_intercepted_404_when_not_found(client):
    """POST /api/snare/intercepted/{id}/drop returns 404 when request is not found."""
    import deps
    deps.mitm_manager.drop_intercepted = AsyncMock(return_value=False)

    resp = await client.post(f"/api/snare/intercepted/{uuid.uuid4()}/drop")
    assert resp.status_code == 404
    assert "detail" in resp.json()


@pytest.mark.asyncio
async def test_drop_intercepted_calls_manager_with_correct_id(client):
    """POST /api/snare/intercepted/{id}/drop passes the correct request_id to the manager."""
    import deps
    request_id = str(uuid.uuid4())
    deps.mitm_manager.drop_intercepted = AsyncMock(return_value=True)

    await client.post(f"/api/snare/intercepted/{request_id}/drop")
    deps.mitm_manager.drop_intercepted.assert_called_once_with(request_id)


@pytest.mark.asyncio
async def test_drop_intercepted_does_not_require_body(client):
    """POST /api/snare/intercepted/{id}/drop requires no request body."""
    import deps
    request_id = str(uuid.uuid4())
    deps.mitm_manager.drop_intercepted = AsyncMock(return_value=True)

    # No json= argument — raw POST with no body
    resp = await client.post(f"/api/snare/intercepted/{request_id}/drop")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Error handling — manager raises an exception
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_intercepted_500_on_manager_error(client):
    """GET /api/snare/intercepted returns 500 when the manager raises."""
    import deps
    deps.mitm_manager.list_intercepted = AsyncMock(side_effect=RuntimeError("DB exploded"))

    resp = await client.get("/api/snare/intercepted")
    assert resp.status_code == 500
    assert "detail" in resp.json()


@pytest.mark.asyncio
async def test_forward_intercepted_500_on_manager_error(client):
    """POST /api/snare/intercepted/{id}/forward returns 500 when the manager raises."""
    import deps
    deps.mitm_manager.forward_intercepted = AsyncMock(side_effect=RuntimeError("flow gone"))

    resp = await client.post(
        f"/api/snare/intercepted/{uuid.uuid4()}/forward",
        json={},
    )
    assert resp.status_code == 500
    assert "detail" in resp.json()


@pytest.mark.asyncio
async def test_drop_intercepted_500_on_manager_error(client):
    """POST /api/snare/intercepted/{id}/drop returns 500 when the manager raises."""
    import deps
    deps.mitm_manager.drop_intercepted = AsyncMock(side_effect=RuntimeError("flow gone"))

    resp = await client.post(f"/api/snare/intercepted/{uuid.uuid4()}/drop")
    assert resp.status_code == 500
    assert "detail" in resp.json()


@pytest.mark.asyncio
async def test_start_snare_500_on_manager_error(client):
    """POST /api/snare/start returns 500 when the manager raises."""
    import deps
    deps.mitm_manager.start_snare = AsyncMock(side_effect=RuntimeError("proxy not running"))

    resp = await client.post("/api/snare/start")
    assert resp.status_code == 500
    assert "detail" in resp.json()


@pytest.mark.asyncio
async def test_stop_snare_500_on_manager_error(client):
    """POST /api/snare/stop returns 500 when the manager raises."""
    import deps
    deps.mitm_manager.stop_snare = AsyncMock(side_effect=RuntimeError("proxy not running"))

    resp = await client.post("/api/snare/stop")
    assert resp.status_code == 500
    assert "detail" in resp.json()


# ---------------------------------------------------------------------------
# POST /api/snare/response/{id}/forward
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_forward_response_returns_200(client):
    """POST /api/snare/response/{id}/forward returns 200 when response is found."""
    import deps
    request_id = str(uuid.uuid4())
    deps.mitm_manager.forward_response = AsyncMock(return_value=True)

    resp = await client.post(f"/api/snare/response/{request_id}/forward", json={})
    assert resp.status_code == 200
    assert resp.json()["message"] == "Response forwarded"


@pytest.mark.asyncio
async def test_forward_response_404_when_not_found(client):
    """POST /api/snare/response/{id}/forward returns 404 when response is not held."""
    import deps
    deps.mitm_manager.forward_response = AsyncMock(return_value=False)

    resp = await client.post(f"/api/snare/response/{uuid.uuid4()}/forward", json={})
    assert resp.status_code == 404
    assert "detail" in resp.json()


@pytest.mark.asyncio
async def test_forward_response_calls_manager_with_correct_id(client):
    """POST /api/snare/response/{id}/forward passes the correct request_id."""
    import deps
    request_id = str(uuid.uuid4())
    deps.mitm_manager.forward_response = AsyncMock(return_value=True)

    await client.post(f"/api/snare/response/{request_id}/forward", json={})
    deps.mitm_manager.forward_response.assert_called_once_with(request_id, None)


@pytest.mark.asyncio
async def test_forward_response_passes_raw_response(client):
    """POST /api/snare/response/{id}/forward passes raw_response to the manager."""
    import deps
    request_id = str(uuid.uuid4())
    deps.mitm_manager.forward_response = AsyncMock(return_value=True)

    raw = "HTTP/1.1 200 OK\nContent-Type: text/plain\n\nHello"
    await client.post(f"/api/snare/response/{request_id}/forward", json={"raw_response": raw})
    deps.mitm_manager.forward_response.assert_called_once_with(request_id, raw)


@pytest.mark.asyncio
async def test_forward_response_500_on_manager_error(client):
    """POST /api/snare/response/{id}/forward returns 500 when the manager raises."""
    import deps
    deps.mitm_manager.forward_response = AsyncMock(side_effect=RuntimeError("flow gone"))

    resp = await client.post(f"/api/snare/response/{uuid.uuid4()}/forward", json={})
    assert resp.status_code == 500
    assert "detail" in resp.json()


# ---------------------------------------------------------------------------
# POST /api/snare/response/{id}/drop
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_drop_response_returns_200(client):
    """POST /api/snare/response/{id}/drop returns 200 when response is found."""
    import deps
    request_id = str(uuid.uuid4())
    deps.mitm_manager.drop_response = AsyncMock(return_value=True)

    resp = await client.post(f"/api/snare/response/{request_id}/drop")
    assert resp.status_code == 200
    assert resp.json()["message"] == "Response dropped"


@pytest.mark.asyncio
async def test_drop_response_404_when_not_found(client):
    """POST /api/snare/response/{id}/drop returns 404 when response is not held."""
    import deps
    deps.mitm_manager.drop_response = AsyncMock(return_value=False)

    resp = await client.post(f"/api/snare/response/{uuid.uuid4()}/drop")
    assert resp.status_code == 404
    assert "detail" in resp.json()


@pytest.mark.asyncio
async def test_drop_response_calls_manager_with_correct_id(client):
    """POST /api/snare/response/{id}/drop passes the correct request_id."""
    import deps
    request_id = str(uuid.uuid4())
    deps.mitm_manager.drop_response = AsyncMock(return_value=True)

    await client.post(f"/api/snare/response/{request_id}/drop")
    deps.mitm_manager.drop_response.assert_called_once_with(request_id)


@pytest.mark.asyncio
async def test_drop_response_500_on_manager_error(client):
    """POST /api/snare/response/{id}/drop returns 500 when the manager raises."""
    import deps
    deps.mitm_manager.drop_response = AsyncMock(side_effect=RuntimeError("flow gone"))

    resp = await client.post(f"/api/snare/response/{uuid.uuid4()}/drop")
    assert resp.status_code == 500
    assert "detail" in resp.json()


# ---------------------------------------------------------------------------
# FerretAddon._should_snare — unit tests (no HTTP, direct logic)
# ---------------------------------------------------------------------------

class _FakeRequest:
    """Minimal stand-in for mitmproxy's HTTPRequest."""
    def __init__(self, method="GET", host="example.com", path="/", headers=None, content=b""):
        self.method = method
        self.host = host
        self.path = path
        self.headers = headers or {}
        self.content = content


class _FakeFlow:
    def __init__(self, method="GET", host="example.com", path="/", headers=None, content=b""):
        self.request = _FakeRequest(method, host, path, headers, content)


def _make_addon_with_rules(rules):
    """Return a FerretAddon instance with the given SnareRule list (no real mitmproxy)."""
    from mitmproxy_manager import FerretAddon
    import threading
    addon = FerretAddon.__new__(FerretAddon)
    addon.db_client = None
    addon.loop = None
    addon.ws_manager = None
    addon._started_event = threading.Event()
    addon.snare_rules = rules
    addon.snare_enabled = True
    addon.intercepted_requests = {}
    addon.intercepted_responses = {}
    return addon


def _make_snare_rule(
    rule_id=None,
    name="Rule",
    enabled=True,
    method=None,
    host_pattern=None,
    path_pattern=None,
    header_filters=None,
    body_pattern=None,
):
    from models import SnareRule
    return SnareRule(
        id=rule_id or str(uuid.uuid4()),
        name=name,
        enabled=enabled,
        method=method,
        host_pattern=host_pattern,
        path_pattern=path_pattern,
        header_filters=header_filters,
        body_pattern=body_pattern,
        action="snare",
    )


def test_should_snare_catch_all_when_no_rules():
    """With no rules configured, _should_snare returns True for any request (catch-all)."""
    addon = _make_addon_with_rules([])
    flow = _FakeFlow(method="GET", host="anything.com", path="/whatever")
    assert addon._should_snare(flow) is True


def test_should_snare_catch_all_when_all_rules_disabled():
    """With only disabled rules, _should_snare returns True (catch-all — no enabled rules)."""
    rule = _make_snare_rule(enabled=False, host_pattern=r"other\.com")
    addon = _make_addon_with_rules([rule])
    flow = _FakeFlow(host="example.com")
    assert addon._should_snare(flow) is True


def test_should_snare_matches_host_pattern():
    """A rule with a host_pattern matches requests whose host matches the regex."""
    rule = _make_snare_rule(host_pattern=r"api\.example\.com")
    addon = _make_addon_with_rules([rule])
    assert addon._should_snare(_FakeFlow(host="api.example.com")) is True
    assert addon._should_snare(_FakeFlow(host="other.com")) is False


def test_should_snare_matches_path_pattern():
    """A rule with a path_pattern matches requests whose path matches the regex."""
    rule = _make_snare_rule(path_pattern=r"^/admin")
    addon = _make_addon_with_rules([rule])
    assert addon._should_snare(_FakeFlow(path="/admin/users")) is True
    assert addon._should_snare(_FakeFlow(path="/public/page")) is False


def test_should_snare_matches_method():
    """A rule with a method filter only matches requests with that HTTP method."""
    rule = _make_snare_rule(method="POST")
    addon = _make_addon_with_rules([rule])
    assert addon._should_snare(_FakeFlow(method="POST")) is True
    assert addon._should_snare(_FakeFlow(method="GET")) is False


def test_should_snare_matches_combined_filters():
    """A rule with host + path + method must match all three to intercept."""
    rule = _make_snare_rule(method="POST", host_pattern=r"api\.example\.com", path_pattern=r"/login")
    addon = _make_addon_with_rules([rule])
    # All three match
    assert addon._should_snare(_FakeFlow(method="POST", host="api.example.com", path="/login")) is True
    # Wrong method
    assert addon._should_snare(_FakeFlow(method="GET", host="api.example.com", path="/login")) is False
    # Wrong host
    assert addon._should_snare(_FakeFlow(method="POST", host="other.com", path="/login")) is False
    # Wrong path
    assert addon._should_snare(_FakeFlow(method="POST", host="api.example.com", path="/logout")) is False


def test_should_snare_first_matching_rule_wins():
    """If multiple rules exist, the first matching one causes interception."""
    rule_no_match = _make_snare_rule(host_pattern=r"nomatch\.com")
    rule_match = _make_snare_rule(host_pattern=r"example\.com")
    addon = _make_addon_with_rules([rule_no_match, rule_match])
    assert addon._should_snare(_FakeFlow(host="example.com")) is True


def test_should_snare_body_pattern():
    """A rule with a body_pattern matches requests whose body contains the pattern."""
    rule = _make_snare_rule(body_pattern=r"password")
    addon = _make_addon_with_rules([rule])
    assert addon._should_snare(_FakeFlow(content=b'{"password": "secret"}')) is True
    assert addon._should_snare(_FakeFlow(content=b'{"username": "alice"}')) is False

"""
Proxy management, snare rules, and gnaw endpoints.
"""

import asyncio
import uuid
import ipaddress
import httpx
from urllib.parse import urlparse
from fastapi import APIRouter, HTTPException
from typing import List, Optional
from pydantic import BaseModel

import deps
from models import HttpRequest, ProxySettings, SnareRule, GnawTab

# Ferret is a penetration-testing tool; its gnaw/send endpoints are intentionally
# designed to reach arbitrary hosts including LAN addresses (192.168.x.x, 10.x.x.x,
# etc.) that a tester may be assessing.
#
# The SSRF threat model here is narrower: prevent an *unauthenticated web attacker*
# from using the Ferret API as a pivot to reach Ferret's own internal Docker
# Compose services (docker-proxy, api, ui, lab) or the loopback interface of the
# container itself.
#
# Blocked:
#   - Loopback (127.x.x.x, ::1, localhost) — would reach the API container itself
#   - Docker Compose service names (docker-proxy, api, ui, lab) — internal pivot by name
#   - 172.16.0.0/12 — Docker's internal bridge network range; Compose service IPs
#     always fall here.  Blocking by name alone is insufficient because an attacker
#     who knows (or enumerates) the container IP can bypass the hostname check.
#     Pentesters never legitimately target 172.16-31.x.x — their LAN targets are
#     10.x.x.x or 192.168.x.x.
#
# Allowed: 10.x.x.x, 192.168.x.x — legitimate pentest targets on the user's LAN.
_BLOCKED_INTERNAL_HOSTS = frozenset({
    # Docker Compose service names — these resolve to internal container IPs
    "docker-proxy", "api", "ui", "lab",
    # Loopback — would reach the API container itself
    "localhost", "127.0.0.1", "::1",
})

# IP networks that are always blocked regardless of hostname
_BLOCKED_IP_NETWORKS = (
    ipaddress.ip_network("127.0.0.0/8"),    # IPv4 loopback
    ipaddress.ip_network("::1/128"),         # IPv6 loopback
    ipaddress.ip_network("172.16.0.0/12"),   # Docker internal bridge range
)


def _assert_safe_url(url: str) -> None:
    """Raise HTTP 400 if the URL targets Ferret's own internal services or loopback.

    LAN/private addresses (192.168.x.x, 10.x.x.x) are intentionally allowed because
    Ferret is a pentest tool and testers routinely target internal network hosts.

    Blocked: loopback, Docker Compose service names, and 172.16.0.0/12 (Docker's
    internal bridge range — container IPs always fall here, so blocking by hostname
    alone is insufficient against an attacker who knows the container IP).
    """
    try:
        parsed = urlparse(url)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid URL")
    host = (parsed.hostname or "").lower()
    if not host:
        raise HTTPException(status_code=400, detail="URL must include a host")
    if host in _BLOCKED_INTERNAL_HOSTS:
        raise HTTPException(status_code=400, detail="Requests to internal hosts are not permitted")
    try:
        addr = ipaddress.ip_address(host)
        if any(addr in net for net in _BLOCKED_IP_NETWORKS):
            raise HTTPException(status_code=400, detail="Requests to internal/loopback addresses are not permitted")
    except ValueError:
        pass  # it's a hostname, not a bare IP — already checked above

router = APIRouter()


# ---------------------------------------------------------------------------
# Proxy management
# ---------------------------------------------------------------------------

@router.get("/api/proxy/status")
async def get_proxy_status():
    try:
        return await deps.mitm_manager.get_status()
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/proxy/start")
async def start_proxy():
    try:
        loop = asyncio.get_running_loop()
        await deps.mitm_manager.start(db_client=deps.db_client, loop=loop, ws_manager=deps.ws_manager)
        return {"message": "Proxy started successfully"}
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/proxy/stop")
async def stop_proxy():
    try:
        await deps.mitm_manager.stop()
        return {"message": "Proxy stopped successfully"}
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/proxy/settings", response_model=ProxySettings)
async def get_proxy_settings():
    try:
        return await deps.mitm_manager.get_settings()
    except Exception as e:
        raise deps.server_error(e)


@router.put("/api/proxy/settings")
async def update_proxy_settings(settings: ProxySettings):
    try:
        await deps.mitm_manager.update_settings(settings)
        return {"message": "Settings updated successfully"}
    except Exception as e:
        raise deps.server_error(e)


# ---------------------------------------------------------------------------
# Snare rules
# ---------------------------------------------------------------------------

@router.get("/api/snare/rules", response_model=List[SnareRule])
async def get_snare_rules():
    try:
        return await deps.mitm_manager.get_snare_rules()
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/snare/rules")
async def add_snare_rule(rule: SnareRule):
    try:
        await deps.mitm_manager.add_snare_rule(rule)
        return {"message": "Snare rule added successfully"}
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/snare/rules/{rule_id}")
async def delete_snare_rule(rule_id: str):
    try:
        await deps.mitm_manager.delete_snare_rule(rule_id)
        return {"message": "Snare rule deleted successfully"}
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/snare/start")
async def start_snare():
    try:
        await deps.mitm_manager.start_snare()
        return {"message": "Snare started successfully"}
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/snare/stop")
async def stop_snare():
    try:
        await deps.mitm_manager.stop_snare()
        return {"message": "Snare stopped successfully"}
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/snare/intercepted")
async def list_intercepted():
    """Return all currently intercepted (pending) requests."""
    try:
        return await deps.mitm_manager.list_intercepted()
    except Exception as e:
        raise deps.server_error(e)


class ForwardRequest(BaseModel):
    raw_request: Optional[str] = None


@router.post("/api/snare/intercepted/{request_id}/forward")
async def forward_intercepted(request_id: str, body: ForwardRequest):
    """
    Phase 1 forward: send the (optionally modified) request to the upstream server.
    The server response will be held and broadcast via WS as snare_response_ready.
    Use POST /api/snare/response/{request_id}/forward to release it to the client.
    """
    try:
        result = await deps.mitm_manager.forward_intercepted(request_id, body.raw_request)
        if not result.get("forwarded"):
            raise HTTPException(status_code=404, detail="Intercepted request not found")
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/snare/intercepted/{request_id}/drop")
async def drop_intercepted(request_id: str):
    """Drop (kill) an intercepted request without forwarding it."""
    try:
        ok = await deps.mitm_manager.drop_intercepted(request_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Intercepted request not found")
        return {"message": "Request dropped"}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


class ForwardResponseRequest(BaseModel):
    raw_response: Optional[str] = None


@router.post("/api/snare/response/{request_id}/forward")
async def forward_response(request_id: str, body: ForwardResponseRequest):
    """
    Phase 2 forward: release the (optionally modified) server response to the client.
    If raw_response is provided, the response is patched before being sent.
    """
    try:
        ok = await deps.mitm_manager.forward_response(request_id, body.raw_response)
        if not ok:
            raise HTTPException(status_code=404, detail="Intercepted response not found")
        return {"message": "Response forwarded"}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/snare/response/{request_id}/drop")
async def drop_response(request_id: str):
    """
    Phase 2 drop: discard the held server response and send a 502 to the client.
    """
    try:
        ok = await deps.mitm_manager.drop_response(request_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Intercepted response not found")
        return {"message": "Response dropped"}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


# ---------------------------------------------------------------------------
# Gnaw
# ---------------------------------------------------------------------------

@router.post("/api/gnaw/send")
async def send_request(request: HttpRequest):
    """Send a request through the gnaw and return the actual HTTP response."""
    try:
        await deps.db_client.set_setting("gnaw_current_request", request.model_dump_json())

        method = request.method.upper() if hasattr(request.method, "upper") else str(request.method).upper()
        url = request.url
        headers = {
            k: v for k, v in (request.headers or {}).items()
            if k.lower() not in ("host", "content-length", "transfer-encoding")
        }
        body = request.body.encode() if request.body else None

        _assert_safe_url(url)
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=False, verify=True) as client:
            resp = await client.request(method, url, headers=headers, content=body)

        try:
            resp_body = resp.text
        except Exception:
            resp_body = resp.content.decode("utf-8", errors="replace")

        elapsed_ms = round(resp.elapsed.total_seconds() * 1000)

        return {
            "status_code": resp.status_code,
            "response_headers": dict(resp.headers),
            "response_body": resp_body,
            "response_time": elapsed_ms,
        }
    except HTTPException:
        raise
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Request failed: {e}")
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/gnaw/current", response_model=HttpRequest)
async def get_gnaw_current():
    """Return the last request sent to the gnaw, so the page can pre-populate on mount."""
    try:
        raw = await deps.db_client.get_setting("gnaw_current_request")
        if not raw:
            raise HTTPException(status_code=404, detail="No gnaw request stored yet")
        return HttpRequest.model_validate_json(raw)
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


# ---------------------------------------------------------------------------
# Gnaw Tabs (project-scoped, persistent)
# ---------------------------------------------------------------------------

class CreateTabRequest(BaseModel):
    raw_request: Optional[str] = None
    label: Optional[str] = None


class UpdateTabRequest(BaseModel):
    label: str
    raw_request: Optional[str] = None


@router.get("/api/gnaw/tabs")
async def list_gnaw_tabs():
    """List all gnaw tabs for the active project."""
    try:
        project_id = await deps.db_client.get_setting("active_project_id") or "temp"
        tabs = await deps.db_client.list_gnaw_tabs(project_id)
        return tabs
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/gnaw/tabs", status_code=201)
async def create_gnaw_tab(body: CreateTabRequest):
    """Create a new gnaw tab, optionally pre-populated with a request."""
    try:
        project_id = await deps.db_client.get_setting("active_project_id") or "temp"
        tab_id = str(uuid.uuid4())
        label = body.label or "New Tab"
        tab = await deps.db_client.create_gnaw_tab(
            tab_id=tab_id,
            label=label,
            raw_request=body.raw_request,
            project_id=project_id,
        )
        return tab
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/gnaw/tabs/{tab_id}")
async def get_gnaw_tab(tab_id: str):
    """Get a single gnaw tab (including request and response)."""
    try:
        project_id = await deps.db_client.get_setting("active_project_id") or "temp"
        tab = await deps.db_client.get_gnaw_tab(tab_id, project_id)
        if not tab:
            raise HTTPException(status_code=404, detail="Tab not found")
        return tab
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.put("/api/gnaw/tabs/{tab_id}")
async def update_gnaw_tab(tab_id: str, body: UpdateTabRequest):
    """Update the label and/or raw request content of a tab."""
    try:
        project_id = await deps.db_client.get_setting("active_project_id") or "temp"
        ok = await deps.db_client.update_gnaw_tab(
            tab_id=tab_id,
            label=body.label,
            raw_request=body.raw_request,
            project_id=project_id,
        )
        if not ok:
            raise HTTPException(status_code=404, detail="Tab not found")
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/gnaw/tabs/{tab_id}", status_code=204)
async def delete_gnaw_tab(tab_id: str):
    """Delete a gnaw tab."""
    try:
        project_id = await deps.db_client.get_setting("active_project_id") or "temp"
        ok = await deps.db_client.delete_gnaw_tab(tab_id, project_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Tab not found")
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/gnaw/tabs/{tab_id}/send")
async def send_gnaw_tab(tab_id: str, request: HttpRequest):
    """Send the HTTP request for a specific tab and persist the response."""
    try:
        project_id = await deps.db_client.get_setting("active_project_id") or "temp"

        # Verify tab exists
        tab = await deps.db_client.get_gnaw_tab(tab_id, project_id)
        if not tab:
            raise HTTPException(status_code=404, detail="Tab not found")

        method = request.method.upper() if hasattr(request.method, "upper") else str(request.method).upper()
        url = request.url
        headers = {
            k: v for k, v in (request.headers or {}).items()
            if k.lower() not in ("host", "content-length", "transfer-encoding")
        }
        body = request.body.encode() if request.body else None

        _assert_safe_url(url)
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=False, verify=True) as client:
            resp = await client.request(method, url, headers=headers, content=body)

        try:
            resp_body = resp.text
        except Exception:
            resp_body = resp.content.decode("utf-8", errors="replace")

        elapsed_ms = round(resp.elapsed.total_seconds() * 1000)

        response_data = {
            "status_code": resp.status_code,
            "response_headers": dict(resp.headers),
            "response_body": resp_body,
            "response_time": elapsed_ms,
        }

        # Persist response and update label with method+host
        new_label = f"{method} {request.host or request.url}"
        await deps.db_client.update_gnaw_tab(
            tab_id=tab_id,
            label=new_label,
            raw_request=tab.get("raw_request"),
            project_id=project_id,
        )
        await deps.db_client.save_gnaw_tab_response(tab_id, response_data, project_id)

        return response_data
    except HTTPException:
        raise
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Request failed: {e}")
    except Exception as e:
        raise deps.server_error(e)

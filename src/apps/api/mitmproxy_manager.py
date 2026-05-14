"""
Mitmproxy Manager for FERRET
Handles mitmproxy instance lifecycle and configuration.

Key design decisions vs. the original:
- No longer creates its own ElasticsearchClient; receives the shared SQLiteClient
  from main.py so there is exactly one DB connection.
- The async/threading bug is fixed: FerretAddon.request() / response() now use
  asyncio.run_coroutine_threadsafe(coro, loop) to schedule coroutines onto the
  FastAPI event loop from the mitmproxy daemon thread, instead of the broken
  asyncio.create_task() call that targeted the wrong loop.
"""

import asyncio
import json
import uuid
from datetime import datetime
from typing import List, Dict, Any, Optional
from mitmproxy import http
from mitmproxy.tools.dump import DumpMaster
from mitmproxy.options import Options
import threading
import time

from models import HttpRequest, ProxySettings, ProxyStats, SnareRule


class FerretAddon:
    """Mitmproxy addon that captures traffic and stores it via the shared SQLiteClient."""

    def __init__(
        self,
        db_client,
        loop: asyncio.AbstractEventLoop,
        ws_manager,
        started_event: threading.Event,
    ):
        self.db_client = db_client
        self.loop = loop
        self.ws_manager = ws_manager
        self._started_event = started_event
        self.snare_rules: List[SnareRule] = []
        self.snare_enabled = False
        # Phase 1: request intercepted, waiting for user to forward/drop
        self.intercepted_requests: Dict[str, http.HTTPFlow] = {}
        # Phase 2: response intercepted, waiting for user to forward/drop response
        self.intercepted_responses: Dict[str, http.HTTPFlow] = {}

    # ------------------------------------------------------------------
    # mitmproxy hooks (called from mitmproxy's thread)
    # ------------------------------------------------------------------

    def running(self) -> None:
        """
        Called by mitmproxy after it has bound its listening port and is
        fully ready to accept connections.  This is the correct place to
        signal startup — NOT before master.run() is awaited.
        """
        print("[proxy] running() hook fired — port is bound and ready", flush=True)
        self._started_event.set()

    def request(self, flow: http.HTTPFlow) -> None:
        """Handle incoming HTTP request."""
        try:
            request_id = str(uuid.uuid4())
            flow.request.ferret_id = request_id  # type: ignore[attr-defined]

            if self.snare_enabled and self._should_snare(flow):
                self.intercepted_requests[request_id] = flow
                flow.intercept()
                http_request = self._create_request_object(flow, request_id)
                # Broadcast intercept event so the UI can show the pending request
                asyncio.run_coroutine_threadsafe(
                    self._broadcast_intercepted(http_request), self.loop
                )
                asyncio.run_coroutine_threadsafe(
                    self._store_request_with_project(http_request), self.loop
                )
                return

            http_request = self._create_request_object(flow, request_id)
            # Schedule onto the FastAPI event loop — safe cross-thread call
            asyncio.run_coroutine_threadsafe(
                self._store_request_with_project(http_request), self.loop
            )
        except Exception as e:
            print(f"Error handling request: {e}")

    async def _store_request_with_project(self, http_request) -> None:
        """Read the active project from settings then store the request."""
        try:
            project_id = await self.db_client.get_setting("active_project_id") or "temp"
        except Exception:
            project_id = "temp"
        await self.db_client.store_request(http_request, project_id=project_id)

    def response(self, flow: http.HTTPFlow) -> None:
        """Handle HTTP response."""
        try:
            request_id = getattr(flow.request, "ferret_id", None)
            if not request_id:
                return

            # Phase 2: if this response came back from a snare-forwarded request,
            # intercept it so the user can review (and optionally modify) before
            # it is released to the client.
            if request_id in self.intercepted_responses or getattr(flow.request, "snare_forwarded", False):
                resp = flow.response
                response_data: Dict[str, Any] = {
                    "status_code": resp.status_code if resp else None,
                    "response_headers": dict(resp.headers) if resp else {},
                    "response_body": resp.content.decode("utf-8", errors="replace") if resp and resp.content else "",
                    "response_time": (
                        (flow.response.timestamp_end - flow.request.timestamp_start) * 1000
                        if resp and hasattr(resp, "timestamp_end") and resp.timestamp_end
                        else None
                    ),
                }
                # Hold the flow so we can resume it later
                self.intercepted_responses[request_id] = flow
                flow.intercept()
                asyncio.run_coroutine_threadsafe(
                    self._broadcast_response_intercepted(request_id, response_data), self.loop
                )
                return

            http_request = self._create_request_object(flow, request_id, include_response=True)

            asyncio.run_coroutine_threadsafe(
                self.db_client.update_request(request_id, http_request), self.loop
            )
            asyncio.run_coroutine_threadsafe(
                self._broadcast(http_request), self.loop
            )
        except Exception as e:
            print(f"Error handling response: {e}")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _broadcast(self, http_request: HttpRequest) -> None:
        message = json.dumps({"type": "new_request", "data": http_request.model_dump(mode="json")})
        await self.ws_manager.broadcast(message)

    async def _broadcast_intercepted(self, http_request: HttpRequest) -> None:
        message = json.dumps({"type": "snare_intercepted", "data": http_request.model_dump(mode="json")})
        await self.ws_manager.broadcast(message)

    async def _broadcast_response_intercepted(self, request_id: str, response_data: Dict[str, Any]) -> None:
        message = json.dumps({
            "type": "snare_response_ready",
            "data": {"request_id": request_id, **response_data},
        })
        await self.ws_manager.broadcast(message)

    async def _broadcast_client_disconnected(self, request_id: str) -> None:
        message = json.dumps({
            "type": "snare_client_disconnected",
            "data": {"request_id": request_id},
        })
        await self.ws_manager.broadcast(message)

    def _should_snare(self, flow: http.HTTPFlow) -> bool:
        """
        Return True if this flow should be intercepted.

        Behaviour:
        - No rules configured → intercept ALL requests (catch-all).
        - Rules configured → intercept only requests that match at least one
          enabled rule.  A rule with no filters set matches every request.
        """
        enabled_rules = [r for r in self.snare_rules if r.enabled]
        if not enabled_rules:
            # Catch-all: snare is on but no rules — intercept everything
            return True

        import re
        for rule in enabled_rules:
            if rule.method and flow.request.method != rule.method.value:
                continue
            if rule.host_pattern and not re.search(rule.host_pattern, flow.request.host):
                continue
            if rule.path_pattern and not re.search(rule.path_pattern, flow.request.path):
                continue
            if rule.header_filters:
                match = True
                for header_name, header_pattern in rule.header_filters.items():
                    if not re.search(header_pattern, flow.request.headers.get(header_name, "")):
                        match = False
                        break
                if not match:
                    continue
            if rule.body_pattern and flow.request.content:
                body_text = flow.request.content.decode("utf-8", errors="ignore")
                if not re.search(rule.body_pattern, body_text):
                    continue
            return True
        return False

    def _create_request_object(
        self, flow: http.HTTPFlow, request_id: str, include_response: bool = False
    ) -> HttpRequest:
        request = flow.request
        response = flow.response if include_response and flow.response else None

        query_params = dict(request.query) if request.query else None
        client_ip = flow.client_conn.address[0] if flow.client_conn.address else None
        server_ip = flow.server_conn.address[0] if flow.server_conn.address else None
        tls_version = None
        if flow.client_conn.tls_established:
            tls_version = getattr(flow.client_conn.tls_version, "name", "Unknown")

        http_request = HttpRequest(
            id=request_id,
            timestamp=datetime.fromtimestamp(flow.request.timestamp_start),
            method=request.method,
            url=request.pretty_url,
            host=request.host,
            path=request.path,
            query_params=query_params,
            headers=dict(request.headers),
            body=request.content.decode("utf-8", errors="ignore") if request.content else None,
            content_type=request.headers.get("content-type"),
            content_length=len(request.content) if request.content else 0,
            client_ip=client_ip,
            server_ip=server_ip,
            tls_version=tls_version,
            intercepted=request_id in self.intercepted_requests,
        )

        if response:
            http_request.status_code = response.status_code
            http_request.response_headers = dict(response.headers)
            http_request.response_body = (
                response.content.decode("utf-8", errors="ignore") if response.content else None
            )
            http_request.response_time = (
                flow.response.timestamp_end - flow.request.timestamp_start
            ) * 1000
            http_request.response_size = len(response.content) if response.content else 0

        return http_request


class MitmproxyManager:
    """Manages the mitmproxy DumpMaster lifecycle."""

    def __init__(self):
        self.master: Optional[DumpMaster] = None
        self.addon: Optional[FerretAddon] = None
        self.thread: Optional[threading.Thread] = None
        self.settings = ProxySettings()
        self.start_time: Optional[float] = None
        self.stats = ProxyStats()
        self._proxy_loop: Optional[asyncio.AbstractEventLoop] = None
        self._started_event: Optional[threading.Event] = None
        self._start_error: Optional[Exception] = None
        self._db_client = None
        self._fastapi_loop: Optional[asyncio.AbstractEventLoop] = None
        self._ws_manager = None

    async def start(self, db_client, loop: asyncio.AbstractEventLoop, ws_manager) -> None:
        """Start mitmproxy. Idempotent — does nothing if already running."""
        if self._proxy_running():
            print("Proxy is already running")
            return

        # Store args so the thread can use them
        self._db_client = db_client
        self._fastapi_loop = loop
        self._ws_manager = ws_manager

        # The event is set by FerretAddon.running(), which mitmproxy calls only
        # after the listening socket is bound — so when we unblock here the
        # port is guaranteed to be accepting connections.
        self._started_event = threading.Event()
        self._start_error = None
        self._proxy_loop = None

        self.thread = threading.Thread(target=self._run_proxy, daemon=True)
        self.thread.start()

        # Wait up to 10 s for FerretAddon.running() to fire (port bound)
        if not self._started_event.wait(timeout=10):
            raise RuntimeError("mitmproxy failed to start within 10 seconds")
        if self._start_error:
            raise self._start_error

        self.start_time = time.time()
        print(f"Proxy started on {self.settings.listen_host}:{self.settings.listen_port}")

    def _proxy_running(self) -> bool:
        return self.master is not None and not self.master.should_exit.is_set()

    def _run_proxy(self) -> None:
        """
        Runs in a daemon thread. DumpMaster MUST be constructed inside a
        running event loop (it calls asyncio.get_running_loop() in __init__),
        so we create it inside the async coroutine after asyncio.run() has
        started the loop.

        IMPORTANT: uvicorn installs uvloop as the global event loop policy.
        mitmproxy 10.x is incompatible with uvloop and silently fails to bind.
        We explicitly create a standard asyncio SelectorEventLoop to bypass
        the uvloop policy.
        """
        import traceback

        # Explicitly create a SelectorEventLoop — do NOT use asyncio.new_event_loop()
        # or asyncio.run() because uvicorn installs uvloop as the global policy and
        # mitmproxy 10.x is incompatible with uvloop (silently fails to bind).
        import selectors
        selector = selectors.DefaultSelector()
        loop = asyncio.SelectorEventLoop(selector)
        asyncio.set_event_loop(loop)
        print(f"[proxy] Loop type: {type(loop).__name__}", flush=True)

        async def _run():
            try:
                # Capture this thread's event loop so stop() can use it later
                self._proxy_loop = asyncio.get_running_loop()

                # Persist the mitmproxy CA cert in the db_data volume so it
                # survives container rebuilds.  Without this, mitmproxy
                # regenerates a new CA on every fresh container start and the
                # user has to re-import the cert into their browser.
                import os as _os
                _confdir = _os.getenv("MITMPROXY_CONFDIR", "/data/mitmproxy")
                _os.makedirs(_confdir, exist_ok=True)

                opts = Options(
                    listen_host=self.settings.listen_host,
                    listen_port=self.settings.listen_port,
                    upstream_cert=self.settings.upstream_cert,
                    ssl_insecure=self.settings.ssl_insecure,
                    http2=self.settings.http2,
                    websocket=self.settings.websocket,
                    rawtcp=self.settings.raw_tcp,
                    tcp_hosts=self.settings.rawtcp_ports,
                    # Always pass the mode as a list — an empty list means
                    # "no proxy mode" which causes the port to bind but
                    # immediately refuse all connections.
                    mode=[self.settings.mode],
                    confdir=_confdir,
                )
                print(f"[proxy] Creating DumpMaster on {self.settings.listen_host}:{self.settings.listen_port}")
                # DumpMaster.__init__ calls asyncio.get_running_loop() — must
                # be constructed here, inside the running loop.
                self.master = DumpMaster(opts, with_termlog=False, with_dumper=False)
                self.addon = FerretAddon(
                    db_client=self._db_client,
                    loop=self._fastapi_loop,
                    ws_manager=self._ws_manager,
                    # The addon's running() hook fires after the port is bound;
                    # that is the correct moment to unblock start().
                    started_event=self._started_event,
                )
                self.master.addons.add(self.addon)
                print(f"[proxy] Calling master.run() on loop {type(asyncio.get_running_loop()).__name__}", flush=True)
                # Do NOT set _started_event here — let FerretAddon.running() do it
                # after the port is actually bound.
                await self.master.run()
                print(f"[proxy] master.run() returned — should_exit={self.master.should_exit.is_set()}")
            except Exception as e:
                print(f"[proxy] ERROR: {type(e).__name__}: {e}")
                traceback.print_exc()
                self._start_error = e
                self._started_event.set()  # unblock the waiter even on error

        try:
            loop.run_until_complete(_run())
        finally:
            loop.close()

    async def stop(self) -> None:
        if self.master:
            # master lives in the proxy thread's event loop; use the thread-safe
            # call to schedule shutdown() onto that loop instead of calling it
            # directly from the FastAPI loop.
            if hasattr(self, '_proxy_loop') and self._proxy_loop:
                self._proxy_loop.call_soon_threadsafe(self.master.shutdown)
            else:
                # Fallback: shutdown() is safe to call directly if the proxy
                # loop has already exited or was never stored.
                try:
                    self.master.shutdown()
                except Exception:
                    pass
            if self.thread:
                self.thread.join(timeout=5)
            self.master = None
            self.addon = None
            self.thread = None
            self.start_time = None
            print("Proxy stopped")

    async def get_status(self) -> Dict[str, Any]:
        is_running = self.master is not None and not self.master.should_exit.is_set()
        uptime = time.time() - self.start_time if self.start_time else 0
        return {
            "running": is_running,
            "uptime": uptime,
            "listen_address": f"{self.settings.listen_host}:{self.settings.listen_port}",
            "intercepted": len(self.addon.intercepted_requests) if self.addon else 0,
        }

    async def get_settings(self) -> ProxySettings:
        return self.settings

    async def update_settings(self, settings: ProxySettings) -> None:
        self.settings = settings
        if self.master:
            # Restart is required for settings to take effect; caller must supply
            # db_client/loop/ws_manager again via the /api/proxy/start endpoint.
            await self.stop()

    async def get_snare_rules(self) -> List[SnareRule]:
        return self.addon.snare_rules if self.addon else []

    async def add_snare_rule(self, rule: SnareRule) -> None:
        if self.addon:
            self.addon.snare_rules.append(rule)

    async def delete_snare_rule(self, rule_id: str) -> None:
        if self.addon:
            self.addon.snare_rules = [
                r for r in self.addon.snare_rules if r.id != rule_id
            ]

    async def start_snare(self) -> None:
        if self.addon:
            self.addon.snare_enabled = True

    async def stop_snare(self) -> None:
        if self.addon:
            self.addon.snare_enabled = False
            for flow in self.addon.intercepted_requests.values():
                flow.resume()
            self.addon.intercepted_requests.clear()

    async def list_intercepted(self) -> List[Dict[str, Any]]:
        """Return a list of pending intercepted requests as serialisable dicts."""
        if not self.addon:
            return []
        result = []
        for request_id, flow in self.addon.intercepted_requests.items():
            req = self.addon._create_request_object(flow, request_id)
            result.append(req.model_dump(mode="json"))
        return result

    async def forward_intercepted(
        self,
        request_id: str,
        modified_raw: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Phase 1 forward: send the (optionally modified) request to the upstream
        server.  The response() hook will intercept the server's reply and hold
        it for Phase 2 (forward_response).

        Returns {"forwarded": False} if the request_id is not found.
        Returns {"forwarded": True} immediately after resuming the flow.
        """
        if not self.addon:
            return {"forwarded": False}
        flow = self.addon.intercepted_requests.pop(request_id, None)
        if flow is None:
            return {"forwarded": False}

        if modified_raw:
            # Parse the raw HTTP text and patch the mitmproxy request in-place
            try:
                lines = modified_raw.split("\n")
                first_parts = (lines[0] if lines else "").split(" ")
                method = first_parts[0] if first_parts else flow.request.method
                raw_path = first_parts[1] if len(first_parts) > 1 else flow.request.path

                # Extract headers and body from raw text
                header_lines: List[str] = []
                body_lines: List[str] = []
                blank_found = False
                for line in lines[1:]:
                    if not blank_found:
                        if line.strip() == "":
                            blank_found = True
                        else:
                            header_lines.append(line)
                    else:
                        body_lines.append(line)

                # Build headers dict (preserve Host)
                new_headers: Dict[str, str] = {}
                host = flow.request.host
                for hl in header_lines:
                    idx = hl.find(":")
                    if idx > 0:
                        k = hl[:idx].strip()
                        v = hl[idx + 1:].strip()
                        if k.lower() == "host":
                            host = v
                        else:
                            new_headers[k] = v

                body_text = "\n".join(body_lines).strip()

                # Patch the flow
                flow.request.method = method.upper()
                flow.request.path = raw_path
                flow.request.host = host
                # Replace headers (keep Host)
                from mitmproxy.net.http import Headers
                header_items = [("Host", host)] + list(new_headers.items())
                flow.request.headers = Headers(
                    [(k.encode(), v.encode()) for k, v in header_items]
                )
                if body_text:
                    flow.request.content = body_text.encode("utf-8")
                else:
                    flow.request.content = b""
            except Exception as e:
                print(f"[snare] Failed to apply modification: {e}")

        # Detect client disconnect: if the client TCP connection is already closed,
        # skip Phase 2 (don't intercept the response) and notify the UI so it can
        # clean up instead of waiting forever.
        from mitmproxy.connection import ConnectionState
        client_alive = bool(flow.client_conn.state)  # False when state == CLOSED (0)
        if not client_alive:
            # Still resume so mitmproxy cleans up the flow internally, but don't
            # set snare_forwarded — the response() hook will not intercept the reply.
            asyncio.run_coroutine_threadsafe(
                self.addon._broadcast_client_disconnected(request_id), self.addon.loop
            )
            if self._proxy_loop:
                self._proxy_loop.call_soon_threadsafe(flow.resume)
            else:
                try:
                    flow.resume()
                except Exception:
                    pass
            return {"forwarded": True, "client_disconnected": True}

        # Mark so the response() hook knows to intercept the reply
        flow.request.snare_forwarded = True  # type: ignore[attr-defined]

        # Resume the (possibly modified) flow — mitmproxy must be called from its own thread
        if self._proxy_loop:
            self._proxy_loop.call_soon_threadsafe(flow.resume)
        else:
            try:
                flow.resume()
            except Exception:
                pass

        return {"forwarded": True}

    async def drop_intercepted(self, request_id: str) -> bool:
        """
        Drop (kill) an intercepted request by injecting a 502 response and
        resuming the flow.

        Background: flow.kill() only works reliably when called synchronously
        inside the mitmproxy request() hook.  Once a flow has been paused via
        flow.intercept(), the only cross-thread-safe way to abort it is to
        inject a synthetic error response and call flow.resume() — mitmproxy
        will then send that response to the client and close the connection.

        Returns True if found and dropped, False if not found.
        """
        if not self.addon:
            return False
        flow = self.addon.intercepted_requests.pop(request_id, None)
        if flow is None:
            return False

        def _inject_error_and_resume():
            try:
                from mitmproxy.http import Response
                flow.response = Response.make(
                    502,
                    b"Connection dropped by Snare",
                    {"Content-Type": "text/plain"},
                )
            except Exception as e:
                print(f"[snare] drop: failed to set error response: {e}")
            try:
                flow.resume()
            except Exception as e:
                print(f"[snare] drop: failed to resume flow: {e}")

        if self._proxy_loop:
            self._proxy_loop.call_soon_threadsafe(_inject_error_and_resume)
        else:
            _inject_error_and_resume()
        return True

    async def forward_response(
        self,
        request_id: str,
        modified_raw_response: Optional[str] = None,
    ) -> bool:
        """
        Phase 2 forward: release the (optionally modified) server response to the client.

        If modified_raw_response is provided, the raw HTTP response text is parsed and
        the flow's response object is patched before resuming.

        Returns True if found and released, False if not found.
        """
        if not self.addon:
            return False
        flow = self.addon.intercepted_responses.pop(request_id, None)
        if flow is None:
            return False

        if modified_raw_response and flow.response:
            try:
                lines = modified_raw_response.split("\n")
                # First line: HTTP/1.1 <status_code> [reason]
                status_code = flow.response.status_code
                if lines:
                    parts = lines[0].split(" ", 2)
                    if len(parts) >= 2:
                        try:
                            status_code = int(parts[1])
                        except ValueError:
                            pass

                # Split headers and body at the first blank line
                header_lines: List[str] = []
                body_lines: List[str] = []
                blank_found = False
                for line in lines[1:]:
                    if not blank_found:
                        if line.strip() == "":
                            blank_found = True
                        else:
                            header_lines.append(line)
                    else:
                        body_lines.append(line)

                # Build a headers dict for Response.make
                headers_dict: Dict[str, str] = {}
                for hl in header_lines:
                    idx = hl.find(":")
                    if idx > 0:
                        headers_dict[hl[:idx].strip()] = hl[idx + 1:].strip()

                body_text = "\n".join(body_lines).strip()

                # Replace the entire response using the canonical mitmproxy API
                from mitmproxy.http import Response as MitmResponse
                flow.response = MitmResponse.make(
                    status_code,
                    body_text.encode("utf-8") if body_text else b"",
                    headers_dict if headers_dict else {"Content-Type": "text/plain"},
                )
            except Exception as e:
                print(f"[snare] forward_response: failed to apply modification: {e}")

        # Store the completed request/response in history
        http_request = self.addon._create_request_object(flow, request_id, include_response=True)
        asyncio.run_coroutine_threadsafe(
            self.addon.db_client.update_request(request_id, http_request), self.addon.loop
        )
        asyncio.run_coroutine_threadsafe(
            self.addon._broadcast(http_request), self.addon.loop
        )

        if self._proxy_loop:
            self._proxy_loop.call_soon_threadsafe(flow.resume)
        else:
            try:
                flow.resume()
            except Exception:
                pass
        return True

    async def drop_response(self, request_id: str) -> bool:
        """
        Phase 2 drop: discard the held server response and send a 502 to the client.

        Returns True if found and dropped, False if not found.
        """
        if not self.addon:
            return False
        flow = self.addon.intercepted_responses.pop(request_id, None)
        if flow is None:
            return False

        def _replace_and_resume():
            try:
                from mitmproxy.http import Response
                flow.response = Response.make(
                    502,
                    b"Response dropped by Snare",
                    {"Content-Type": "text/plain"},
                )
            except Exception as e:
                print(f"[snare] drop_response: failed to replace response: {e}")
            try:
                flow.resume()
            except Exception as e:
                print(f"[snare] drop_response: failed to resume flow: {e}")

        if self._proxy_loop:
            self._proxy_loop.call_soon_threadsafe(_replace_and_resume)
        else:
            _replace_and_resume()
        return True

    async def send_request(self, request: HttpRequest) -> Dict[str, Any]:
        """Replay a request (stub — returns placeholder)."""
        return {
            "message": "Request sent successfully",
            "request_id": request.id,
            "timestamp": datetime.utcnow().isoformat(),
        }

"""
Ferret Docker-exec shim
=======================
A minimal HTTP/1.1 reverse proxy that sits between the Ferret API container
and the Docker Unix socket.  It allows ONLY the Docker API calls needed
for `docker exec` and `docker cp` against the single hardcoded sandbox
container, and blocks everything else with HTTP 403.

Allowed patterns (versioned /v1.xx/... and bare paths both match):
  GET   /[v1.*/]_ping                                        — version negotiation
  HEAD  /[v1.*/]_ping                                        — version negotiation
  GET   /[v1.*/]containers/<ALLOWED_CONTAINER>/json          — container-inspect
  POST  /[v1.*/]containers/<ALLOWED_CONTAINER>/exec          — exec-create
  POST  /[v1.*/]exec/<hex-id>/start                          — exec-start  (may hijack)
  POST  /[v1.*/]exec/<hex-id>/resize                         — exec-resize
  GET   /[v1.*/]exec/<hex-id>/json                           — exec-inspect
  PUT   /[v1.*/]containers/<ALLOWED_CONTAINER>/archive       — docker cp (host→container)
  GET   /[v1.*/]containers/<ALLOWED_CONTAINER>/archive       — docker cp (container→host)
  HEAD  /[v1.*/]containers/<ALLOWED_CONTAINER>/archive       — docker cp (stat path)

Everything else → 403.

Environment variables:
  ALLOWED_CONTAINER   container name the shim will accept (default: ferret-lab)
  DOCKER_SOCK         path to the Docker Unix socket   (default: /var/run/docker.sock)
  LISTEN_PORT         TCP port to listen on            (default: 2375)

No third-party dependencies — stdlib only.
"""

import json
import logging
import os
import re
import select
import socket
import threading

# ── Configuration ──────────────────────────────────────────────────────────────

ALLOWED_CONTAINER = os.environ.get("ALLOWED_CONTAINER", "ferret-lab")
DOCKER_SOCK       = os.environ.get("DOCKER_SOCK", "/var/run/docker.sock")
LISTEN_PORT       = int(os.environ.get("LISTEN_PORT", "2375"))

# ── Logging ────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [shim] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("ferret-shim")

# ── Allow-list patterns ────────────────────────────────────────────────────────
# Each entry is (method, compiled-regex).  The optional version prefix
# /v1.NN is stripped before matching so patterns are written without it.

_HEX = r"[0-9a-fA-F]+"
_CONTAINER = re.escape(ALLOWED_CONTAINER)

ALLOW_PATTERNS = [
    # ping: GET|HEAD /_ping
    # Docker CLI sends this before every command to negotiate the API version.
    ("GET",   re.compile(r"^/_ping$")),
    ("HEAD",  re.compile(r"^/_ping$")),
    # container-inspect: GET /containers/ferret-lab/json
    # Docker CLI resolves the container name → ID before issuing exec-create.
    ("GET",   re.compile(rf"^/containers/{_CONTAINER}/json$")),
    # exec-create: POST /containers/ferret-lab/exec
    ("POST",  re.compile(rf"^/containers/{_CONTAINER}/exec$")),
    # exec-start: POST /exec/<id>/start
    ("POST",  re.compile(rf"^/exec/{_HEX}/start$")),
    # exec-resize: POST /exec/<id>/resize
    ("POST",  re.compile(rf"^/exec/{_HEX}/resize$")),
    # exec-inspect: GET /exec/<id>/json
    ("GET",   re.compile(rf"^/exec/{_HEX}/json$")),
    # docker-cp: archive endpoint scoped to ferret-lab only.
    # PUT  → copy file/dir into the container  (docker cp host → container)
    # GET  → copy file/dir out of the container (docker cp container → host)
    # HEAD → stat a path inside the container
    ("PUT",   re.compile(rf"^/containers/{_CONTAINER}/archive$")),
    ("GET",   re.compile(rf"^/containers/{_CONTAINER}/archive$")),
    ("HEAD",  re.compile(rf"^/containers/{_CONTAINER}/archive$")),
]

# Regex to strip the optional /v1.NN version prefix from a request path
_VERSION_PREFIX = re.compile(r"^/v\d+\.\d+")

FORBIDDEN_BODY = json.dumps(
    {"message": "Action not permitted by Ferret docker-shim"}
).encode()


def _is_allowed(method: str, path: str) -> bool:
    """Return True if the request should be forwarded to Docker."""
    # Strip query string for matching
    bare = path.split("?", 1)[0]
    # Strip optional version prefix
    bare = _VERSION_PREFIX.sub("", bare)
    for allowed_method, pattern in ALLOW_PATTERNS:
        if method == allowed_method and pattern.match(bare):
            return True
    return False


# ── Raw HTTP helpers ───────────────────────────────────────────────────────────

def _recv_line(sock: socket.socket) -> bytes:
    """Read one CRLF-terminated line from *sock* (used for HTTP/1.1 headers)."""
    buf = bytearray()
    while True:
        ch = sock.recv(1)
        if not ch:
            break
        buf += ch
        if buf.endswith(b"\r\n"):
            break
    return bytes(buf)


def _recv_headers(sock: socket.socket):
    """
    Read the HTTP request line + headers from *sock*.

    Returns (request_line_bytes, headers_dict, raw_header_block_bytes).
    raw_header_block_bytes includes the request line, all header lines, and
    the final blank CRLF — i.e. everything up to (but not including) the body.
    """
    raw = bytearray()
    request_line = _recv_line(sock)
    if not request_line:
        return None, {}, b""
    raw += request_line

    headers: dict[str, str] = {}
    while True:
        line = _recv_line(sock)
        raw += line
        stripped = line.rstrip(b"\r\n")
        if not stripped:
            break
        if b":" in stripped:
            key, _, value = stripped.partition(b":")
            headers[key.strip().lower().decode("latin-1")] = value.strip().decode("latin-1")

    return request_line, headers, bytes(raw)


def _pipe_bytes(src: socket.socket, dst: socket.socket, label: str):
    """Forward bytes from *src* to *dst* until *src* closes."""
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    log.debug("%s pipe closed", label)


def _pipe_bidirectional(client_sock: socket.socket, docker_sock: socket.socket):
    """
    Bidirectional byte pipe for hijacked exec-start streams.
    Runs until both sides close.
    """
    t1 = threading.Thread(
        target=_pipe_bytes, args=(client_sock, docker_sock, "client→docker"), daemon=True
    )
    t2 = threading.Thread(
        target=_pipe_bytes, args=(docker_sock, client_sock, "docker→client"), daemon=True
    )
    t1.start()
    t2.start()
    t1.join()
    t2.join()


# ── Core proxy logic ───────────────────────────────────────────────────────────

def _send_403(client_sock: socket.socket):
    """Send a 403 Forbidden response and close the connection."""
    body = FORBIDDEN_BODY
    response = (
        b"HTTP/1.1 403 Forbidden\r\n"
        b"Content-Type: application/json\r\n"
        b"Connection: close\r\n"
        + b"Content-Length: " + str(len(body)).encode() + b"\r\n"
        + b"\r\n"
        + body
    )
    try:
        client_sock.sendall(response)
    except OSError:
        pass


def _forward_to_docker(
    client_sock: socket.socket,
    raw_headers: bytes,
    headers: dict,
    method: str,
    path: str,
) -> bool:
    """
    Open a fresh Unix socket to Docker, forward the full request
    (headers + body), then stream the response back to the client.

    For exec-start with Detach:false Docker upgrades the connection to a raw
    multiplexed stream.  We detect the 101/200 upgrade and switch to a raw
    bidirectional pipe so we don't try to parse the framing.

    Returns True if the client connection should be kept alive for another
    request (HTTP/1.1 keep-alive), False if it should be closed.
    """
    docker_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        docker_sock.connect(DOCKER_SOCK)
    except OSError as exc:
        log.error("Cannot connect to Docker socket %s: %s", DOCKER_SOCK, exc)
        try:
            client_sock.sendall(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
        except OSError:
            pass
        return

    try:
        # ── Forward request headers ────────────────────────────────────────────
        log.debug("→ Docker headers: %r", raw_headers[:256])
        docker_sock.sendall(raw_headers)

        # ── Forward request body (if any) ──────────────────────────────────────
        content_length_str = headers.get("content-length", "")
        transfer_enc = headers.get("transfer-encoding", "").lower()
        log.debug("Request body: content-length=%r transfer-encoding=%r", content_length_str, transfer_enc)

        if content_length_str:
            remaining = int(content_length_str)
            log.debug("Forwarding %d-byte body by content-length", remaining)
            while remaining > 0:
                chunk = client_sock.recv(min(remaining, 65536))
                if not chunk:
                    break
                docker_sock.sendall(chunk)
                remaining -= len(chunk)
        elif transfer_enc == "chunked":
            # Forward chunked body verbatim
            log.debug("Forwarding chunked body")
            while True:
                size_line = _recv_line(client_sock).rstrip(b"\r\n")
                docker_sock.sendall(size_line + b"\r\n")
                chunk_size = int(size_line, 16)
                if chunk_size == 0:
                    docker_sock.sendall(b"\r\n")
                    break
                data = b""
                while len(data) < chunk_size + 2:  # +2 for trailing CRLF
                    part = client_sock.recv(chunk_size + 2 - len(data))
                    if not part:
                        break
                    data += part
                docker_sock.sendall(data)
        elif method in ("PUT", "POST", "PATCH"):
            # No Content-Length and not chunked but body-bearing method —
            # shut down the write side of the client socket so Docker sees EOF,
            # then pipe until Docker closes its end.
            log.debug("No content-length for %s — piping until client write-EOF", method)
            try:
                client_sock.shutdown(socket.SHUT_WR)
            except OSError:
                pass
            while True:
                chunk = client_sock.recv(65536)
                if not chunk:
                    break
                docker_sock.sendall(chunk)

        # ── Read Docker's response status line + headers ───────────────────────
        resp_line, resp_headers, resp_raw = _recv_headers(docker_sock)
        if not resp_line:
            log.debug("No response from Docker for %s %s", method, path)
            return False

        # Parse status code
        parts = resp_line.split(None, 2)
        status_code = int(parts[1]) if len(parts) >= 2 else 0
        log.debug("← Docker response: %r (status %d)", resp_line, status_code)

        # Forward the response headers to the client
        client_sock.sendall(resp_raw)

        # ── Detect hijack / upgrade ────────────────────────────────────────────
        # Docker signals a hijacked stream with:
        #   HTTP/1.1 200 OK  +  Content-Type: application/vnd.docker.raw-stream
        # or occasionally a 101 Switching Protocols.
        content_type = resp_headers.get("content-type", "")
        is_hijack = (
            status_code == 101
            or "vnd.docker.raw-stream" in content_type
            or "vnd.docker.multiplexed-stream" in content_type
        )

        if is_hijack:
            log.debug("Hijacked stream detected for %s %s — switching to raw pipe", method, path)
            _pipe_bidirectional(client_sock, docker_sock)
            return False  # bidirectional pipe owns the connection now

        # ── Stream normal response body ────────────────────────────────────────
        resp_transfer = resp_headers.get("transfer-encoding", "").lower()
        resp_length_str = resp_headers.get("content-length", "")
        resp_conn = resp_headers.get("connection", "").lower()

        # HEAD responses never have a body regardless of other headers.
        if method == "HEAD":
            log.debug("HEAD response — no body to forward")
        elif resp_transfer == "chunked":
            # Forward chunked response verbatim
            while True:
                size_line = _recv_line(docker_sock).rstrip(b"\r\n")
                client_sock.sendall(size_line + b"\r\n")
                chunk_size = int(size_line, 16)
                if chunk_size == 0:
                    client_sock.sendall(b"\r\n")
                    break
                data = b""
                while len(data) < chunk_size + 2:
                    part = docker_sock.recv(chunk_size + 2 - len(data))
                    if not part:
                        break
                    data += part
                client_sock.sendall(data)
        elif resp_length_str:
            remaining = int(resp_length_str)
            while remaining > 0:
                chunk = docker_sock.recv(min(remaining, 65536))
                if not chunk:
                    break
                client_sock.sendall(chunk)
                remaining -= len(chunk)
        elif resp_conn == "close":
            # No content-length, not chunked, and server said close —
            # safe to stream until Docker closes the socket.
            while True:
                chunk = docker_sock.recv(65536)
                if not chunk:
                    break
                client_sock.sendall(chunk)
        else:
            # No content-length, not chunked, server did NOT say close —
            # this is a keep-alive response with an empty body (e.g. 404 with
            # no body, or 200 No Content).  Nothing to forward.
            log.debug("No body to forward for %d response (no content-length, not chunked, keep-alive)", status_code)

        # Keep the client connection alive unless either side said close
        req_conn = headers.get("connection", "").lower()
        keep_alive = (resp_conn != "close" and req_conn != "close")
        log.debug("Connection keep-alive=%s (req=%r resp=%r)", keep_alive, req_conn, resp_conn)
        return keep_alive

    except OSError as exc:
        log.debug("Socket error during proxy: %s", exc)
        return False
    finally:
        try:
            docker_sock.close()
        except OSError:
            pass


def _handle_client(client_sock: socket.socket, addr):
    """Handle one incoming TCP connection from the Docker client (API container).

    Loops over multiple requests on the same connection to support HTTP/1.1
    keep-alive (Docker CLI reuses the connection for HEAD + PUT on docker cp).
    The loop exits when:
      - _forward_to_docker returns False (connection: close or hijack)
      - the client closes the connection (empty request line)
      - a 403 is sent (blocked request)
      - an error occurs
    """
    log.debug("New connection from %s", addr)
    try:
        while True:
            request_line, headers, raw_headers = _recv_headers(client_sock)
            if not request_line:
                # Client closed the connection
                log.debug("Client %s closed connection", addr)
                break

            parts = request_line.rstrip(b"\r\n").split(None, 2)
            if len(parts) < 2:
                break

            method = parts[0].decode("latin-1")
            path   = parts[1].decode("latin-1")

            allowed = _is_allowed(method, path)
            log.info("%s %s → %s", method, path, "ALLOW" if allowed else "BLOCK")

            if not allowed:
                _send_403(client_sock)
                # After a 403 we close — don't loop on a blocked connection
                break

            keep_alive = _forward_to_docker(client_sock, raw_headers, headers, method, path)
            if not keep_alive:
                log.debug("Closing connection after %s %s (keep_alive=False)", method, path)
                break

    except Exception as exc:  # noqa: BLE001
        log.error("Unhandled error in client handler: %s", exc, exc_info=True)
    finally:
        try:
            client_sock.close()
        except OSError:
            pass


# ── Server ─────────────────────────────────────────────────────────────────────

def main():
    log.info(
        "Ferret docker-shim starting — allowed container: %s, "
        "docker socket: %s, listen port: %d",
        ALLOWED_CONTAINER,
        DOCKER_SOCK,
        LISTEN_PORT,
    )

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", LISTEN_PORT))
    server.listen(128)
    log.info("Listening on 0.0.0.0:%d", LISTEN_PORT)

    while True:
        try:
            client_sock, addr = server.accept()
        except KeyboardInterrupt:
            log.info("Shutting down")
            break
        except OSError as exc:
            log.error("Accept error: %s", exc)
            continue

        t = threading.Thread(
            target=_handle_client, args=(client_sock, addr), daemon=True
        )
        t.start()


if __name__ == "__main__":
    main()

"""
Test mitmproxy with FerretAddon in a daemon thread — full app simulation.
Checks if the addon causes the proxy to crash.
"""
import asyncio
import socket
import threading
import time
import traceback

from mitmproxy.tools.dump import DumpMaster
from mitmproxy.options import Options
from mitmproxy import http

PORT = 19996
started = threading.Event()
errors = []

class MockAddon:
    """Minimal addon that mimics FerretAddon without DB calls."""
    def request(self, flow: http.HTTPFlow) -> None:
        print(f"[addon] request: {flow.request.method} {flow.request.pretty_url}", flush=True)

    def response(self, flow: http.HTTPFlow) -> None:
        print(f"[addon] response: {flow.response.status_code}", flush=True)

def run_proxy():
    async def _run():
        try:
            opts = Options(listen_host="0.0.0.0", listen_port=PORT)
            master = DumpMaster(opts)
            master.addons.add(MockAddon())
            started.set()
            await master.run()
            print(f"[thread] master.run() returned", flush=True)
        except Exception as e:
            print(f"[thread] ERROR: {type(e).__name__}: {e}", flush=True)
            traceback.print_exc()
            errors.append(e)
            started.set()

    asyncio.run(_run())

t = threading.Thread(target=run_proxy, daemon=True)
t.start()

started.wait(timeout=5)
time.sleep(1.5)

s = socket.socket()
s.settimeout(1)
r = s.connect_ex(("127.0.0.1", PORT))
s.close()
print(f"Port {PORT} with MockAddon in daemon thread: {'OPEN' if r == 0 else 'REFUSED (' + str(r) + ')'}", flush=True)
if errors:
    print(f"Errors: {errors}", flush=True)

# Now check what the app's proxy thread status is
import sys
sys.path.insert(0, '/app')
try:
    # Import the running app's manager state
    import importlib.util
    spec = importlib.util.spec_from_file_location("mitmproxy_manager", "/app/mitmproxy_manager.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    print("mitmproxy_manager imported OK", flush=True)
except Exception as e:
    print(f"Import error: {e}", flush=True)

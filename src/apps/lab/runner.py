#!/usr/bin/env python3
import os
import sys
import time
import uuid
import socket
import logging
import tempfile
import subprocess
import requests

# Configure Logging
from collections import deque

class RollingBufferHandler(logging.Handler):
    def __init__(self, maxlen=500):
        super().__init__()
        self.buffer = deque(maxlen=maxlen)

    def emit(self, record):
        try:
            msg = self.format(record)
            self.buffer.append(msg)
        except Exception:
            self.handleError(record)

    def get_logs(self):
        return "\n".join(self.buffer)

rolling_handler = RollingBufferHandler()
rolling_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout), rolling_handler]
)
logger = logging.getLogger("ferret-runner")

# Configuration from Environment
API_URL = os.environ.get("FERRET_API_URL", "http://api:8000").rstrip("/")
RUNNER_KEY = os.environ.get("FERRET_RUNNER_KEY", "fr_local_dev_key_default_33794b")
RUNNER_ID = os.environ.get("FERRET_RUNNER_ID", f"runner-{socket.gethostname()}-{uuid.uuid4().hex[:6]}")
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "3.0"))
HEARTBEAT_INTERVAL = float(os.environ.get("HEARTBEAT_INTERVAL", "15.0"))

logger.info("Starting Ferret Outbound Runner Daemon...")
logger.info(f"API URL: {API_URL}")
logger.info(f"Runner ID: {RUNNER_ID}")
logger.info(f"Runner Key: {RUNNER_KEY[:10]}...{RUNNER_KEY[-4:] if len(RUNNER_KEY) > 14 else ''}")

session = requests.Session()
session.headers.update({
    "X-Runner-Key": RUNNER_KEY,
    "Content-Type": "application/json"
})

def send_heartbeat():
    try:
        url = f"{API_URL}/api/runners/heartbeat"
        payload = {
            "runner_id": RUNNER_ID,
            "url": None,  # Polling-only outbound runner has no incoming URL
            "logs": rolling_handler.get_logs()
        }
        resp = session.post(url, json=payload, timeout=5)
        if resp.status_code == 200:
            logger.debug("Heartbeat sent successfully")
        else:
            logger.error(f"Heartbeat rejected: {resp.status_code} - {resp.text}")
    except Exception as e:
        logger.error(f"Failed to send heartbeat: {e}")

def stream_logs(run_id: str, chunk: str):
    try:
        url = f"{API_URL}/api/runners/runs/{run_id}/log"
        resp = session.post(url, json={"chunk": chunk}, timeout=5)
        if resp.status_code != 200:
            logger.error(f"Failed to upload log chunk: {resp.status_code} - {resp.text}")
    except Exception as e:
        logger.error(f"Error streaming logs: {e}")

def complete_run(run_id: str, exit_code: int, status: str):
    try:
        url = f"{API_URL}/api/runners/runs/{run_id}/complete"
        payload = {
            "exit_code": exit_code,
            "status": status  # "done" or "error"
        }
        resp = session.post(url, json=payload, timeout=5)
        if resp.status_code == 200:
            logger.info(f"Run {run_id} marked complete with status={status}, exit_code={exit_code}")
        else:
            logger.error(f"Failed to report completion: {resp.status_code} - {resp.text}")
    except Exception as e:
        logger.error(f"Error completing run: {e}")

def execute_job(run_payload: dict):
    run_id = run_payload["run_id"]
    script = run_payload["script"]
    interpreter = run_payload.get("interpreter", "bash")
    timeout = run_payload.get("timeout", 600)

    logger.info(f"Executing Job {run_id} [interpreter={interpreter}, timeout={timeout}]")

    # Write script to a temporary file
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sh", delete=False) as temp_file:
        temp_file.write(script)
        temp_file_path = temp_file.name

    try:
        # Determine shell/interpreter command
        if interpreter == "python" or interpreter == "python3":
            cmd = ["python3", temp_file_path]
        else:
            # Fallback to standard POSIX sh if bash is not available (e.g. in minimal Alpine container)
            import shutil
            shell_cmd = "bash" if shutil.which("bash") else "sh"
            cmd = [shell_cmd, temp_file_path]

        logger.info(f"Running command: {' '.join(cmd)}")

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,  # Line buffered
            preexec_fn=os.setsid  # For clean timeouts/kill
        )

        # Stream output in real-time
        current_chunk = []
        last_stream_time = time.time()

        while True:
            line = process.stdout.readline()
            if not line:
                break
            
            logger.info(f"[{run_id[:8]}] {line.rstrip()}")
            current_chunk.append(line)

            # Flush logs every 0.5s or if chunk gets large
            if time.time() - last_stream_time > 0.5 or len(current_chunk) >= 10:
                stream_logs(run_id, "".join(current_chunk))
                current_chunk = []
                last_stream_time = time.time()

        # Flush any remaining logs
        if current_chunk:
            stream_logs(run_id, "".join(current_chunk))

        process.wait(timeout=timeout)
        exit_code = process.returncode
        status = "done" if exit_code == 0 else "error"
        complete_run(run_id, exit_code, status)

    except subprocess.TimeoutExpired:
        logger.error(f"Job {run_id} timed out after {timeout} seconds!")
        # Kill process group
        try:
            os.killpg(os.getpgid(process.pid), 9)
        except Exception:
            pass
        stream_logs(run_id, f"\n[RUNNER ERROR] Job timed out after {timeout} seconds.\n")
        complete_run(run_id, -1, "error")
    except Exception as e:
        logger.error(f"Error during job execution: {e}")
        stream_logs(run_id, f"\n[RUNNER ERROR] Internal execution error: {e}\n")
        complete_run(run_id, -1, "error")
    finally:
        # Clean up temporary script file
        try:
            os.unlink(temp_file_path)
        except Exception:
            pass

def poll_for_jobs():
    try:
        url = f"{API_URL}/api/runners/poll"
        resp = session.post(url, json={"runner_id": RUNNER_ID}, timeout=10)
        if resp.status_code == 401:
            logger.critical("Authentication failed! Verify FERRET_RUNNER_KEY.")
            time.sleep(10)  # Slow down on auth failure
            return
        elif resp.status_code != 200:
            logger.error(f"Polling failed: {resp.status_code} - {resp.text}")
            return

        data = resp.json()
        status = data.get("status", "idle")
        if status == "run":
            execute_job(data)
        elif status == "idle":
            logger.debug("No jobs pending (idle)")
    except Exception as e:
        logger.error(f"Error polling for jobs: {e}")

def main():
    last_heartbeat = 0.0
    while True:
        now = time.time()
        # Heartbeat keeping registration active
        if now - last_heartbeat >= HEARTBEAT_INTERVAL:
            send_heartbeat()
            last_heartbeat = now

        poll_for_jobs()
        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.info("Runner daemon stopped by user.")
        sys.exit(0)

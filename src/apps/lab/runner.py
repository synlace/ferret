#!/usr/bin/env python3
# NOTE: This file (src/apps/lab/runner.py) is the SINGLE SOURCE OF TRUTH for the runner.
# The copy at src/apps/api/runner.py is a generated file copied automatically by `justfile` during build/dev tasks and is git-ignored.
# ALWAYS make edits to this file (src/apps/lab/runner.py), not the generated copy!
import os
import sys
import time
import uuid
import socket
import logging
import tempfile
import subprocess
import requests
import shutil
import threading

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
KILL_IF_UNREACHABLE = os.environ.get("FERRET_KILL_IF_UNREACHABLE", "1") == "1"
IS_WARM_RUNNER = os.environ.get("FERRET_IS_WARM_RUNNER", "0") == "1"
# Warm runners tolerate much longer API outages (deploys, WG blips) before self-terminating.
# Job runners use a short timeout since they have no reason to linger without API contact.
_default_kill_timeout = 1800 if IS_WARM_RUNNER else 180
KILL_TIMEOUT_SECONDS = float(os.environ.get("FERRET_KILL_TIMEOUT_SECONDS", str(_default_kill_timeout)))

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
            return True
        else:
            logger.error(f"Heartbeat rejected: {resp.status_code} - {resp.text}")
            return False
    except Exception as e:
        logger.error(f"Failed to send heartbeat: {e}")
        return False

def stream_logs(run_id: str, chunk: str):
    try:
        url = f"{API_URL}/api/runners/runs/{run_id}/log"
        resp = session.post(url, json={"chunk": chunk}, timeout=5)
        if resp.status_code != 200:
            logger.error(f"Failed to upload log chunk: {resp.status_code} - {resp.text}")
    except Exception as e:
        logger.error(f"Error streaming logs: {e}")

def upload_workspace_archive(run_payload: dict) -> bool:
    """Finds, packages, and pushes local workspace files back to the API server."""
    run_id = run_payload["run_id"]
    workspace_id = run_payload["workspace_id"]
    project_id = run_payload["project_id"]
    
    # Locate ephemeral workspace directory inside container
    container_base = os.environ.get("FERRET_CONTAINER_WORKSPACES_DIR", "/data/workspaces")
    workspace_dir = os.path.join(container_base, project_id, workspace_id)
    
    if not os.path.exists(workspace_dir):
        logger.debug(f"Workspace directory {workspace_dir} does not exist. Skipping file upload.")
        return False

    logger.info(f"Packaging workspace files from {workspace_dir}...")
    
    # Create temporary ZIP of workspace directory
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp_zip:
        tmp_zip_path = tmp_zip.name
    
    try:
        # Create ZIP archive (shutil.make_archive targets tmp_zip_path without .zip suffix)
        shutil.make_archive(tmp_zip_path.replace(".zip", ""), 'zip', workspace_dir)
        
        url = f"{API_URL}/api/runners/runs/{run_id}/workspace-archive"
        logger.info(f"Uploading workspace archive to {url}...")
        
        with open(tmp_zip_path, "rb") as f:
            files = {"file": (f"{run_id}_workspace.zip", f, "application/zip")}
            headers = {"X-Runner-Key": RUNNER_KEY}
            resp = requests.post(url, files=files, headers=headers, timeout=60)
            
            if resp.status_code == 200:
                logger.info("Workspace archive uploaded successfully")
                return True
            else:
                logger.error(f"Workspace upload failed: {resp.status_code} - {resp.text}")
                return False
    except Exception as e:
        logger.error(f"Error packaging/uploading workspace: {e}")
        return False
    finally:
        if os.path.exists(tmp_zip_path):
            os.unlink(tmp_zip_path)

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
        upload_workspace_archive(run_payload)
        complete_run(run_id, exit_code, status)

    except subprocess.TimeoutExpired:
        logger.error(f"Job {run_id} timed out after {timeout} seconds!")
        # Kill process group
        try:
            os.killpg(os.getpgid(process.pid), 9)
        except Exception:
            pass
        stream_logs(run_id, f"\n[RUNNER ERROR] Job timed out after {timeout} seconds.\n")
        upload_workspace_archive(run_payload)
        complete_run(run_id, -1, "error")
    except Exception as e:
        logger.error(f"Error during job execution: {e}")
        stream_logs(run_id, f"\n[RUNNER ERROR] Internal execution error: {e}\n")
        upload_workspace_archive(run_payload)
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
            return False, False
        elif resp.status_code != 200:
            logger.error(f"Polling failed: {resp.status_code} - {resp.text}")
            return False, False

        data = resp.json()
        status = data.get("status", "idle")
        if status == "run":
            execute_job(data)
            return True, True
        elif status == "idle":
            logger.debug("No jobs pending (idle)")
            return True, False
    except Exception as e:
        logger.error(f"Error polling for jobs: {e}")
    return False, False

def main():
    # Start the non-blocking background heartbeat daemon thread
    def heartbeat_loop():
        while True:
            try:
                send_heartbeat()
            except Exception as e:
                logger.error(f"Error in background heartbeat thread: {e}")
            time.sleep(HEARTBEAT_INTERVAL)

    hb_thread = threading.Thread(target=heartbeat_loop, daemon=True)
    hb_thread.start()
    logger.info("Non-blocking background heartbeat thread started.")

    last_active_time = time.time()
    last_successful_contact = time.time()
    while True:
        now = time.time()
        contact_succeeded = False

        poll_ok, job_executed = poll_for_jobs()
        if poll_ok:
            contact_succeeded = True

        if contact_succeeded:
            last_successful_contact = now

        if job_executed:
            last_active_time = now
            if RUNNER_ID.startswith("runner-fargate-") and not IS_WARM_RUNNER:
                logger.info("Fargate runner completed job execution. Initiating shutdown...")
                break

        if RUNNER_ID.startswith("runner-fargate-"):
            if not IS_WARM_RUNNER:
                # Single-use job runner: shut down if idle for over 60 seconds
                if now - last_active_time > 60.0:
                    logger.info("Fargate runner idle timeout reached. Initiating shutdown...")
                    break
            else:
                # Warm pool runner: only shut down due to API loss (never from idle)
                logger.debug("Warm pool runner — idle timeout suppressed.")

            # Self-terminate if API is unreachable beyond the configured timeout and kill_if_unreachable is enabled.
            # Warm runners: default 30 min (survives deploys/WG blips). Job runners: default 3 min.
            if KILL_IF_UNREACHABLE and (now - last_successful_contact > KILL_TIMEOUT_SECONDS):
                logger.critical(
                    f"Fargate runner lost contact with Ferret API for over {int(KILL_TIMEOUT_SECONDS // 60)} minutes. "
                    "Initiating self-preservation shutdown..."
                )
                break

        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.info("Runner daemon stopped by user.")
        sys.exit(0)

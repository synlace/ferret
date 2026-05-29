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
import asyncio
import websockets
import json

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
HEARTBEAT_INTERVAL = float(os.environ.get("HEARTBEAT_INTERVAL", "15.0"))
KILL_IF_UNREACHABLE = os.environ.get("FERRET_KILL_IF_UNREACHABLE", "1") == "1"
IS_WARM_RUNNER = os.environ.get("FERRET_IS_WARM_RUNNER", "0") == "1"
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

async def websocket_heartbeat_loop(ws):
    while True:
        try:
            await ws.send(json.dumps({
                "type": "heartbeat"
            }))
        except Exception as e:
            logger.error(f"Failed to send heartbeat over WebSocket: {e}")
        await asyncio.sleep(HEARTBEAT_INTERVAL)

async def execute_job_async(ws, run_payload):
    run_id = run_payload["run_id"]
    script = run_payload["script"]
    interpreter = run_payload.get("interpreter", "bash")
    timeout = run_payload.get("timeout", 600)

    logger.info(f"Executing Dynamic Job {run_id} [interpreter={interpreter}, timeout={timeout}]")

    with tempfile.NamedTemporaryFile(mode="w", suffix=".sh", delete=False) as temp_file:
        temp_file.write(script)
        temp_file_path = temp_file.name

    try:
        if interpreter in ("python", "python3"):
            cmd = ["python3", temp_file_path]
        else:
            shell_cmd = "bash" if shutil.which("bash") else "sh"
            cmd = [shell_cmd, temp_file_path]

        logger.info(f"Running command: {' '.join(cmd)}")

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            preexec_fn=os.setsid
        )

        current_chunk = []
        last_stream_time = time.time()

        # Read output line-by-line asynchronously
        while True:
            line_bytes = await process.stdout.readline()
            if not line_bytes:
                break
            line = line_bytes.decode("utf-8", errors="replace")
            logger.info(f"[{run_id[:8]}] {line.rstrip()}")
            current_chunk.append(line)

            # Flush logs every 0.5s or if chunk gets large
            if time.time() - last_stream_time > 0.5 or len(current_chunk) >= 10:
                await ws.send(json.dumps({
                    "type": "execution_log",
                    "run_id": run_id,
                    "chunk": "".join(current_chunk)
                }))
                current_chunk = []
                last_stream_time = time.time()

        # Flush any remaining logs
        if current_chunk:
            await ws.send(json.dumps({
                "type": "execution_log",
                "run_id": run_id,
                "chunk": "".join(current_chunk)
            }))

        await process.wait()
        exit_code = process.returncode
        status = "done" if exit_code == 0 else "error"
        
        # Package and upload workspace archive asynchronously
        await asyncio.to_thread(upload_workspace_archive, run_payload)
        
        # Send completion event over WebSocket
        await ws.send(json.dumps({
            "type": "execution_complete",
            "run_id": run_id,
            "exit_code": exit_code,
            "status": status
        }))
        logger.info(f"Job {run_id} finished with exit_code={exit_code}, status={status}")

    except Exception as e:
        logger.error(f"Error during job execution: {e}")
        try:
            await ws.send(json.dumps({
                "type": "execution_log",
                "run_id": run_id,
                "chunk": f"\n[RUNNER ERROR] Internal execution error: {e}\n"
            }))
        except Exception:
            pass
        await asyncio.to_thread(upload_workspace_archive, run_payload)
        try:
            await ws.send(json.dumps({
                "type": "execution_complete",
                "run_id": run_id,
                "exit_code": -1,
                "status": "error"
            }))
        except Exception:
            pass
    finally:
        try:
            os.unlink(temp_file_path)
        except Exception:
            pass

async def async_main():
    api_ws_url = API_URL.replace("http://", "ws://").replace("https://", "wss://")
    ws_uri = f"{api_ws_url}/api/runners/{RUNNER_ID}/control"
    
    logger.info(f"Connecting to WebSocket control channel at {ws_uri}...")
    headers = {"X-Runner-Key": RUNNER_KEY}

    backoff = 1
    last_active_time = time.time()
    last_successful_contact = time.time()
    
    while True:
        try:
            async with websockets.connect(ws_uri, extra_headers=headers) as ws:
                logger.info("Successfully connected to central API WebSocket control channel.")
                backoff = 1  # Reset backoff on success
                last_successful_contact = time.time()
                
                # Start background heartbeat sender task
                heartbeat_task = asyncio.create_task(websocket_heartbeat_loop(ws))
                
                try:
                    async for message_raw in ws:
                        message = json.loads(message_raw)
                        mtype = message.get("type")
                        if mtype == "execute_command":
                            payload = message.get("payload")
                            last_active_time = time.time()
                            asyncio.create_task(execute_job_async(ws, payload))
                            
                            # Single-use Fargate runner: initiate shutdown after a job runs and finishes
                            if RUNNER_ID.startswith("runner-fargate-") and not IS_WARM_RUNNER:
                                # Give job some time to start, or let it complete asynchronously
                                pass
                except websockets.ConnectionClosed:
                    logger.warning("WebSocket control connection closed by server.")
                finally:
                    heartbeat_task.cancel()
        except Exception as e:
            logger.error(f"Failed to connect or maintain WebSocket: {e}. Reconnecting in {backoff}s...")
            
            # Fargate runner lifecycle checks during API outage
            now = time.time()
            if RUNNER_ID.startswith("runner-fargate-"):
                if not IS_WARM_RUNNER:
                    if now - last_active_time > 60.0:
                        logger.info("Fargate runner idle timeout reached. Initiating shutdown...")
                        break
                if KILL_IF_UNREACHABLE and (now - last_successful_contact > KILL_TIMEOUT_SECONDS):
                    logger.critical(
                        f"Fargate runner lost contact with Ferret API for over {int(KILL_TIMEOUT_SECONDS // 60)} minutes. "
                        "Initiating self-preservation shutdown..."
                    )
                    break
            
            await asyncio.sleep(backoff)
            backoff = min(60, backoff * 2)

if __name__ == "__main__":
    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        logger.info("Runner daemon stopped by user.")

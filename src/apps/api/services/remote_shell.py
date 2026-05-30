import os
import sys
import pty
import fcntl
import asyncio
import logging
from abc import ABC, abstractmethod
from typing import Optional

import deps

_log = logging.getLogger(__name__)

class RunnerShellSession(ABC):
    @abstractmethod
    async def start(self) -> None:
        pass

    @abstractmethod
    async def send_input(self, data: bytes) -> None:
        pass

    @abstractmethod
    async def resize(self, cols: int, rows: int) -> None:
        pass

    @abstractmethod
    def read_output(self, callback) -> None:
        pass

    @abstractmethod
    async def close(self) -> None:
        pass


class MockShellSession(RunnerShellSession):
    def __init__(self, runner_id: str):
        self.runner_id = runner_id
        self.master_fd = None
        self.pid = None
        self.callback = None
        self.loop = None

    async def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        pid, master_fd = pty.fork()
        if pid == 0:
            env = os.environ.copy()
            target_container = self.runner_id
            if target_container == "local":
                target_container = os.getenv("FERRET_SANDBOX_CONTAINER", "ferret-runner")
            elif target_container.startswith("runner-"):
                parts = target_container.split("-")
                if len(parts) == 3:
                    target_container = parts[1]
            # Try starting tmux session inside the sandbox/runner container; fallback to bash
            try:
                args = [
                    "docker", "exec", "-it", target_container,
                    "tmux", "new-session", "-A", "-s", "ferret-shell-mock", "bash", ";", "set-option", "-g", "mouse", "on"
                ]
                os.execvpe("docker", args, env)
            except Exception:
                try:
                    args = ["docker", "exec", "-it", target_container, "bash"]
                    os.execvpe("docker", args, env)
                except Exception:
                    os.execvp("bash", ["bash"])
        else:
            # Parent process
            self.pid = pid
            self.master_fd = master_fd
            # Set non-blocking
            fl = fcntl.fcntl(master_fd, fcntl.F_GETFL)
            fcntl.fcntl(master_fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    async def send_input(self, data: bytes) -> None:
        if self.master_fd is not None:
            os.write(self.master_fd, data)

    async def resize(self, cols: int, rows: int) -> None:
        if self.master_fd is not None:
            import struct
            import termios
            size = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, size)

    def read_output(self, callback) -> None:
        self.callback = callback
        self.loop.add_reader(self.master_fd, self._on_read)

    def _on_read(self) -> None:
        try:
            data = os.read(self.master_fd, 4096)
            if data:
                if self.callback:
                    self.callback(data)
            else:
                self._cleanup()
        except BlockingIOError:
            pass
        except Exception:
            self._cleanup()

    def _cleanup(self) -> None:
        if self.master_fd is not None:
            try:
                self.loop.remove_reader(self.master_fd)
            except Exception:
                pass
            try:
                os.close(self.master_fd)
            except Exception:
                pass
            self.master_fd = None
        if self.pid is not None:
            try:
                os.kill(self.pid, 9)
            except Exception:
                pass
            self.pid = None
        if self.callback:
            # Send EOF/empty to notify closure
            cb = self.callback
            self.callback = None
            try:
                cb(b"")
            except Exception:
                pass

    async def close(self) -> None:
        self._cleanup()


class AWSECSShellSession(RunnerShellSession):
    def __init__(self, runner_id: str):
        self.runner_id = runner_id
        self.master_fd = None
        self.pid = None
        self.callback = None
        self.loop = None

    async def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        
        # 1. Look up Den config
        den_id = "aws"
        if self.runner_id.startswith("runner-fargate-"):
            parts = self.runner_id.split("-")
            if len(parts) >= 4:
                den_id = parts[2]
                
        den = await deps.db_client.get_den(den_id)
        if not den:
            raise Exception("Den config not found in database")

        aws_key = den.get("aws_access_key")
        aws_secret = den.get("aws_secret_key")
        aws_region = den.get("aws_region") or "eu-west-1"

        if not aws_key or not aws_secret:
            raise Exception("Den AWS credentials are missing")

        # 2. Get task ARN
        import boto3
        from botocore.config import Config
        config = Config(region_name=aws_region)
        ecs = boto3.client(
            "ecs",
            aws_access_key_id=aws_key,
            aws_secret_access_key=aws_secret,
            config=config
        )

        resp = ecs.list_tasks(cluster="ferret-runners")
        task_arns = resp.get("taskArns", [])
        if not task_arns:
            raise Exception("No active Fargate tasks found on cluster 'ferret-runners'")

        task_arn = None
        for i in range(0, len(task_arns), 100):
            chunk = task_arns[i:i+100]
            tasks_resp = ecs.describe_tasks(cluster="ferret-runners", tasks=chunk)
            for task in tasks_resp.get("tasks", []):
                container_overrides = task.get("overrides", {}).get("containerOverrides", [])
                for co in container_overrides:
                    env = co.get("environment", [])
                    for env_var in env:
                        if env_var.get("name") == "FERRET_RUNNER_ID" and env_var.get("value") == self.runner_id:
                            task_arn = task.get("taskArn")
                            break
                    if task_arn:
                        break
                if task_arn:
                    break
            if task_arn:
                break

        if not task_arn:
            raise Exception(f"No active Fargate runner task found with ID: {self.runner_id}")

        task_id = task_arn.split("/")[-1]

        # 3. Fork and spawn aws ecs execute-command
        pid, master_fd = pty.fork()
        if pid == 0:
            # Child process: configure subprocess env
            env = os.environ.copy()
            env["AWS_ACCESS_KEY_ID"] = aws_key
            env["AWS_SECRET_ACCESS_KEY"] = aws_secret
            env["AWS_DEFAULT_REGION"] = aws_region

            args = [
                "aws", "ecs", "execute-command",
                "--region", aws_region,
                "--cluster", "ferret-runners",
                "--task", task_id,
                "--container", "runner",
                "--command", "tmux new-session -A -s ferret-shell bash \\; set-option -g mouse on",
                "--interactive"
            ]
            os.execvpe("aws", args, env)
        else:
            # Parent process
            self.pid = pid
            self.master_fd = master_fd
            # Set non-blocking
            fl = fcntl.fcntl(master_fd, fcntl.F_GETFL)
            fcntl.fcntl(master_fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    async def send_input(self, data: bytes) -> None:
        if self.master_fd is not None:
            os.write(self.master_fd, data)

    async def resize(self, cols: int, rows: int) -> None:
        if self.master_fd is not None:
            import struct
            import termios
            size = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, size)

    def read_output(self, callback) -> None:
        self.callback = callback
        self.loop.add_reader(self.master_fd, self._on_read)

    def _on_read(self) -> None:
        try:
            data = os.read(self.master_fd, 4096)
            if data:
                if self.callback:
                    self.callback(data)
            else:
                self._cleanup()
        except BlockingIOError:
            pass
        except Exception:
            self._cleanup()

    def _cleanup(self) -> None:
        if self.master_fd is not None:
            try:
                self.loop.remove_reader(self.master_fd)
            except Exception:
                pass
            try:
                os.close(self.master_fd)
            except Exception:
                pass
            self.master_fd = None
        if self.pid is not None:
            try:
                os.kill(self.pid, 9)
            except Exception:
                pass
            self.pid = None
        if self.callback:
            cb = self.callback
            self.callback = None
            try:
                cb(b"")
            except Exception:
                pass

    async def close(self) -> None:
        self._cleanup()


def create_shell_session(runner_id: str) -> RunnerShellSession:
    """Factory to return either a real AWSECSShellSession or a MockShellSession based on runner id."""
    if runner_id.startswith("runner-fargate-"):
        return AWSECSShellSession(runner_id)
    return MockShellSession(runner_id)


async def kill_shell_session(runner_id: str) -> None:
    """Kills the active tmux shell session in the container or host to allow a clean restart."""
    if not runner_id.startswith("runner-fargate-"):
        try:
            target_container = runner_id
            if target_container == "local":
                target_container = os.getenv("FERRET_SANDBOX_CONTAINER", "ferret-runner")
            elif target_container.startswith("runner-"):
                parts = target_container.split("-")
                if len(parts) == 3:
                    target_container = parts[1]
            proc = await asyncio.create_subprocess_exec(
                "docker", "exec", target_container, "tmux", "kill-session", "-t", "ferret-shell-mock",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL
            )
            await proc.wait()
        except Exception:
            pass
        return

    try:
        den_id = "aws"
        parts = runner_id.split("-")
        if len(parts) >= 4:
            den_id = parts[2]
            
        den = await deps.db_client.get_den(den_id)
        if not den:
            return

        aws_key = den.get("aws_access_key")
        aws_secret = den.get("aws_secret_key")
        aws_region = den.get("aws_region") or "eu-west-1"

        if not aws_key or not aws_secret:
            return

        import boto3
        from botocore.config import Config
        config = Config(region_name=aws_region)
        ecs = boto3.client(
            "ecs",
            aws_access_key_id=aws_key,
            aws_secret_access_key=aws_secret,
            config=config
        )

        resp = ecs.list_tasks(cluster="ferret-runners")
        task_arns = resp.get("taskArns", [])
        if not task_arns:
            return

        task_arn = None
        for i in range(0, len(task_arns), 100):
            chunk = task_arns[i:i+100]
            tasks_resp = ecs.describe_tasks(cluster="ferret-runners", tasks=chunk)
            for task in tasks_resp.get("tasks", []):
                container_overrides = task.get("overrides", {}).get("containerOverrides", [])
                for co in container_overrides:
                    env = co.get("environment", [])
                    for env_var in env:
                        if env_var.get("name") == "FERRET_RUNNER_ID" and env_var.get("value") == runner_id:
                            task_arn = task.get("taskArn")
                            break
                    if task_arn:
                        break
                if task_arn:
                    break
            if task_arn:
                break

        if not task_arn:
            return

        task_id = task_arn.split("/")[-1]

        # Spawn non-interactive execute-command to kill the session
        env = os.environ.copy()
        env["AWS_ACCESS_KEY_ID"] = aws_key
        env["AWS_SECRET_ACCESS_KEY"] = aws_secret
        env["AWS_DEFAULT_REGION"] = aws_region

        proc = await asyncio.create_subprocess_exec(
            "aws", "ecs", "execute-command",
            "--region", aws_region,
            "--cluster", "ferret-runners",
            "--task", task_id,
            "--container", "runner",
            "--command", "tmux kill-session -t ferret-shell",
            "--interactive",
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL
        )
        await proc.wait()
    except Exception as e:
        _log.error(f"Error killing shell session for {runner_id}: {e}")

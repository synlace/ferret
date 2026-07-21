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


def create_shell_session(runner_id: str) -> RunnerShellSession:
    """Factory to return a MockShellSession for the given runner."""
    return MockShellSession(runner_id)


async def kill_shell_session(runner_id: str) -> None:
    """Kills the active tmux shell session in the container to allow a clean restart."""
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

"""
Sandbox Environment Service abstraction (SandboxExecutor).
Turn shallow subprocess and Docker exec logic into a deep, cohesive seam.
"""

from abc import ABC, abstractmethod
import asyncio
import os
import logging
from pathlib import Path
from typing import Dict, List, Optional

_log = logging.getLogger(__name__)

class SandboxExecutor(ABC):
    @abstractmethod
    async def run_pytest(
        self,
        test_path: Path,
        test_name: Optional[str] = None,
        via_proxy: bool = False,
        timeout: float = 60.0
    ) -> asyncio.subprocess.Process:
        """Run pytest inside the sandbox and return the process handle."""
        pass

    @abstractmethod
    async def copy_to_sandbox(self, host_path: str, sandbox_path: str) -> bool:
        """Copy a file from the host filesystem into the sandbox container."""
        pass

    @abstractmethod
    async def execute_command(
        self,
        cmd: List[str],
        env: Optional[Dict[str, str]] = None,
        timeout: float = 60.0
    ) -> asyncio.subprocess.Process:
        """Execute an arbitrary command in the sandbox and return the process handle."""
        pass


class DockerSandboxExecutor(SandboxExecutor):
    def __init__(self, container_name: str = "ferret-runner"):
        self.container_name = container_name

    def with_container(self, name: str) -> "DockerSandboxExecutor":
        """Return a new executor instance targeted at a specific container/runner."""
        return DockerSandboxExecutor(name)

    async def run_pytest(
        self,
        test_path: Path,
        test_name: Optional[str] = None,
        via_proxy: bool = False,
        timeout: float = 60.0
    ) -> asyncio.subprocess.Process:
        cmd = ["docker", "exec"]
        if via_proxy:
            proxy_addr = "http://api:1337"
            cmd += ["-e", f"HTTP_PROXY={proxy_addr}", "-e", f"HTTPS_PROXY={proxy_addr}", "-e", "FERRET_SOURCE=test"]
        
        cmd += [self.container_name, "python3", "-m", "pytest", "-v", "--tb=short", "-s"]
        if test_name:
            cmd.append(f"{test_path}::{test_name}")
        else:
            cmd.append(str(test_path))

        _log.info("Running pytest inside sandbox: %s", " ".join(cmd))
        return await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

    async def copy_to_sandbox(self, host_path: str, sandbox_path: str) -> bool:
        cmd = ["docker", "cp", host_path, f"{self.container_name}:{sandbox_path}"]
        _log.info("Copying file to sandbox: %s", " ".join(cmd))
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        await proc.communicate()
        return proc.returncode == 0

    async def execute_command(
        self,
        cmd: List[str],
        env: Optional[Dict[str, str]] = None,
        timeout: float = 60.0
    ) -> asyncio.subprocess.Process:
        full_cmd = ["docker", "exec"]
        if env:
            for k, v in env.items():
                full_cmd += ["-e", f"{k}={v}"]
        
        full_cmd += [self.container_name] + cmd
        _log.info("Executing command in sandbox: %s", " ".join(full_cmd))
        return await asyncio.create_subprocess_exec(
            *full_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )


class MockSandboxExecutor(SandboxExecutor):
    """Mock sandbox executor for offline unit testing without a running Docker daemon."""
    def __init__(self):
        self.last_run_pytest_args = []
        self.last_copy_to_sandbox_args = []
        self.last_execute_command_args = []

    def with_container(self, name: str) -> "MockSandboxExecutor":
        return self

    async def run_pytest(
        self,
        test_path: Path,
        test_name: Optional[str] = None,
        via_proxy: bool = False,
        timeout: float = 60.0
    ) -> asyncio.subprocess.Process:
        self.last_run_pytest_args.append((test_path, test_name, via_proxy))
        # Returns a mock process with standard pytest stdout
        return await self._create_mock_process(b"============================= 1 passed in 0.01s =============================\n", 0)

    async def copy_to_sandbox(self, host_path: str, sandbox_path: str) -> bool:
        self.last_copy_to_sandbox_args.append((host_path, sandbox_path))
        return True

    async def execute_command(
        self,
        cmd: List[str],
        env: Optional[Dict[str, str]] = None,
        timeout: float = 60.0
    ) -> asyncio.subprocess.Process:
        self.last_execute_command_args.append((cmd, env))
        return await self._create_mock_process(b"mock command execution output\n", 0)

    async def _create_mock_process(self, output: bytes, returncode: int):
        # We start a dummy command like python -c "print(...)" to get a real process object
        import sys
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-c", f"import sys, time; sys.stdout.write({repr(output.decode('utf-8'))}); sys.exit({returncode})",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        return proc

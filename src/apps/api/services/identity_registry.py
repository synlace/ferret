import logging
from typing import Optional, List, Dict, Any
from fastapi import HTTPException
import deps

_log = logging.getLogger(__name__)

class IdentityRegistry:
    """Service to handle runner authentication, presence registration,
    and security boundary validations.
    """

    def __init__(self, db_client=None):
        self._db_client = db_client

    @property
    def db_client(self):
        return self._db_client or deps.db_client

    async def authenticate_key(self, runner_key: str) -> str:
        """Validate the unique runner key and raise 401 if invalid."""
        if not await self.db_client.validate_runner_key(runner_key):
            _log.warning("Authentication failed: invalid runner key %s", runner_key[:10] + "...")
            raise HTTPException(status_code=401, detail="Invalid runner key")
        return runner_key

    async def register_presence(self, runner_id: str, url: Optional[str] = None, logs: Optional[str] = None) -> None:
        """Register the liveness heartbeat status of a runner."""
        await self.db_client.register_runner_heartbeat(runner_id, url, logs)

    async def get_active_identities(self, timeout_seconds: int = 30) -> List[Dict[str, Any]]:
        """Retrieve currently active and online runner identities."""
        return await self.db_client.get_active_runners(timeout_seconds=timeout_seconds)

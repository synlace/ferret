import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from models import Workspace
import deps

_log = logging.getLogger(__name__)


class WorkspaceService:
    """Service to manage Workspaces.
    
    Handles directory structures on disk and database creation.
    """

    def __init__(self, db_client=None, workspaces_dir: Optional[Path] = None):
        self._db_client = db_client
        self._workspaces_dir = workspaces_dir

    @property
    def db_client(self):
        return self._db_client or deps.db_client

    @property
    def workspaces_dir(self) -> Path:
        return self._workspaces_dir or deps.WORKSPACES_DIR

    async def create_workspace(
        self,
        name: str,
        project_id: str,
        parent_id: Optional[str] = None,
    ) -> Workspace:
        """Create a workspace DB row and its root directory on disk."""
        ws_id = str(uuid.uuid4())
        workspace_root = self.workspaces_dir / project_id / ws_id
        workspace_root.mkdir(parents=True, exist_ok=True)

        ws = Workspace(
            id=ws_id,
            project_id=project_id,
            parent_id=parent_id,
            name=name,
            created_at=datetime.utcnow(),
        )
        await self.db_client.create_workspace(ws)
        _log.info("workspace created id=%s project=%s name=%r", ws_id, project_id, name)
        return ws

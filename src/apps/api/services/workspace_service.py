import logging
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict

from models import Workspace
import deps

_log = logging.getLogger(__name__)


class WorkspaceService:
    """Service to manage Workspaces.
    
    Handles directory structures on disk and database creation/deletion.
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

    def count_workspace_files(self, workspace_id: str, project_id: str) -> Dict[str, int]:
        """Return a dict of subdir -> file count for a workspace directory."""
        ws_root = self.workspaces_dir / project_id / workspace_id
        counts: Dict[str, int] = {}
        if ws_root.exists():
            for subdir_path in ws_root.iterdir():
                if subdir_path.is_dir():
                    counts[subdir_path.name] = sum(1 for f in subdir_path.iterdir() if f.is_file())
        return counts

    def list_workspace_files(self, workspace_id: str, project_id: str) -> List[dict]:
        """List all files in a workspace directory, grouped by subdirectory."""
        ws_root = self.workspaces_dir / project_id / workspace_id
        files = []
        if ws_root.exists():
            for subdir_path in sorted(ws_root.iterdir()):
                if not subdir_path.is_dir():
                    continue
                subdir = subdir_path.name
                for f in sorted(subdir_path.iterdir()):
                    if f.is_file():
                        files.append({
                            "path": f"{subdir}/{f.name}",
                            "subdir": subdir,
                            "name": f.name,
                            "size": f.stat().st_size,
                            "modified": f.stat().st_mtime,
                        })
        return files

    def read_workspace_file(self, workspace_id: str, project_id: str, file_path: str) -> dict:
        """Read the text content of a single workspace file, with traversal protection."""
        ws_root = (self.workspaces_dir / project_id / workspace_id).resolve()
        target = (ws_root / file_path).resolve()
        
        # Guard against path traversal — resolve and check prefix
        if not str(target).startswith(str(ws_root) + "/"):
            raise ValueError("Path traversal not allowed")

        if not target.exists() or not target.is_file():
            raise FileNotFoundError("File not found")

        content = target.read_text(errors="replace")
        return {
            "path": file_path,
            "content": content,
            "size": target.stat().st_size,
        }

    async def delete_workspace(self, workspace_id: str, project_id: str) -> bool:
        """Delete a workspace, its DB row, and its files on disk."""
        ok = await self.db_client.delete_workspace(workspace_id)
        if not ok:
            return False

        # Remove the directory tree from disk (non-fatal if already gone)
        ws_root = self.workspaces_dir / project_id / workspace_id
        if ws_root.exists():
            try:
                shutil.rmtree(ws_root)
                _log.info("workspace directory removed: %s", ws_root)
            except Exception as exc:
                _log.warning("failed to remove workspace directory %s: %s", ws_root, exc)
        return True

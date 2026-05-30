import json
import logging
import asyncio
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any
from fastapi import HTTPException
import deps

_log = logging.getLogger(__name__)

class SessionTunnel:
    """Service to encapsulate runner script execution session logging,
    live WebSocket broadcasting, manifest discovery parsing, and state completion.
    """

    def __init__(self, db_client=None, script_engine=None):
        self._db_client = db_client
        self._script_engine = script_engine

    @property
    def db_client(self):
        return self._db_client or deps.db_client

    @property
    def script_engine(self):
        return self._script_engine or deps.script_execution_engine

    async def stream_log_chunk(self, run_id: str, chunk: str) -> None:
        """Append log chunk to run's log file, broadcast to WS, and parse manifests."""
        run = await self.db_client.get_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")

        from services.workflow_logging import ctx_project_id, ctx_workspace_id, ctx_workflow_id, ctx_run_id
        ctx_project_id.set(run["project_id"])
        ctx_workspace_id.set(run["workspace_id"])
        ctx_workflow_id.set(f"pipeline_{run_id}")
        ctx_run_id.set(run_id)

        run_log_path = run.get("run_log_path")
        if not run_log_path:
            log_filename = f"run_{run_id[:8]}.log"
            run_log_path = f"logs/{log_filename}"
            await self.db_client.update_run_status(run_id, status="running", run_log_path=run_log_path)

        log_abs_path = deps.WORKSPACES_DIR / run["project_id"] / run["workspace_id"] / run_log_path
        log_abs_path.parent.mkdir(parents=True, exist_ok=True)

        with log_abs_path.open("a", encoding="utf-8") as f:
            f.write(chunk)
            f.flush()

        # Broadcast lines to active WebSocket sessions and parse manifest discoveries
        lines = chunk.splitlines(keepends=True)
        for line in lines:
            self.script_engine._broadcast(run_id, line)

            stripped = line.strip()
            if stripped.startswith("[FERRET:MANIFEST]"):
                payload_str = stripped[len("[FERRET:MANIFEST]"):].strip()
                try:
                    ws_spec = json.loads(payload_str)
                    existing_children = await self.db_client.get_workspaces(run["project_id"])
                    seen_workspaces = {
                        ws["name"]: ws["id"]
                        for ws in existing_children
                        if ws.get("parent_id") == run["workspace_id"]
                    }

                    ws_name = ws_spec.get("name", "").strip()
                    if ws_name:
                        if ws_name in seen_workspaces:
                            existing_ws_id = seen_workspaces[ws_name]
                            for rel_path, content in ws_spec.get("files", {}).items():
                                try:
                                    target = deps.WORKSPACES_DIR / run["project_id"] / existing_ws_id / rel_path
                                    target.parent.mkdir(parents=True, exist_ok=True)
                                    target.write_text(str(content), encoding="utf-8")
                                except Exception as fe:
                                    _log.warning("run %s: file update error: %s", run_id, fe)
                        else:
                            entry_type = ws_spec.get("type", "host")
                            entry_follow_on = (
                                run.get("follow_on_path_plan_ids") if entry_type == "path" else run.get("follow_on_plan_ids")
                            ) or []
                            asyncio.create_task(
                                self.script_engine._process_manifest_entry(
                                    ws_spec=ws_spec,
                                    parent_workspace_id=run["workspace_id"],
                                    project_id=run["project_id"],
                                    follow_on_plan_ids=entry_follow_on,
                                    seen_workspaces=seen_workspaces,
                                    den_id=run.get("den_id") or "local",
                                )
                            )
                except Exception as json_err:
                    _log.warning("run %s: malformed [FERRET:MANIFEST] line: %s, err: %s", run_id, stripped, json_err)

    async def complete_session_run(self, run_id: str, exit_code: int, status: str) -> None:
        """Mark the run complete, run post-processors, and broadcast completion sentinel."""
        run = await self.db_client.get_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")

        from services.workflow_logging import ctx_project_id, ctx_workspace_id, ctx_workflow_id, ctx_run_id
        ctx_project_id.set(run["project_id"])
        ctx_workspace_id.set(run["workspace_id"])
        ctx_workflow_id.set(f"pipeline_{run_id}")
        ctx_run_id.set(run_id)

        await self.db_client.update_run_status(
            run_id,
            status=status,
            exit_code=exit_code,
            finished_at=datetime.utcnow()
        )

        # Signal WebSocket subscribers that execution is complete
        self.script_engine._broadcast(run_id, None)

        if exit_code == 0:
            ws_root = deps.WORKSPACES_DIR / run["project_id"] / run["workspace_id"]
            existing_children = await self.db_client.get_workspaces(run["project_id"])
            seen_workspaces = {
                ws["name"]: ws["id"]
                for ws in existing_children
                if ws.get("parent_id") == run["workspace_id"]
            }
            await self.script_engine._process_manifest(
                ws_root,
                run["workspace_id"],
                run["project_id"],
                seen_workspaces=seen_workspaces,
                den_id=run.get("den_id") or "local",
            )

            whatweb_json = ws_root / "notes" / "whatweb_raw.json"
            if whatweb_json.exists():
                try:
                    with open(whatweb_json) as f:
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                records = json.loads(line)
                                if isinstance(records, list) and records:
                                    record = records[0]
                                    http_status = record.get("http_status")
                                    if http_status:
                                        await self.db_client.update_workspace_http_status(
                                            run["workspace_id"],
                                            int(http_status)
                                        )
                            except Exception:
                                pass
                except Exception as e:
                    _log.warning("run %s: error parsing whatweb_json: %s", run_id, e)

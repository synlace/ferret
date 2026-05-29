"""
SQLiteClient mixin — Projects, Findings, Chat Sessions, Workspaces, Runs,
Test Runs, Project API Keys, Spend Snapshots, and Settings.

Imported by SQLiteClient via multiple inheritance:
    class SQLiteClient(ProjectsMixin):
        ...
"""

import json
import uuid
import logging
import aiosqlite
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional

from models import Finding, ChatSession, TestRun, Project, ProjectApiKey, Workspace, Run

_log = logging.getLogger(__name__)


class ProjectsMixin:
    """
    Mixin that adds project-scoped CRUD methods to SQLiteClient.
    Requires self._db to be an open aiosqlite.Connection.
    """

    # ------------------------------------------------------------------
    # Findings CRUD
    # ------------------------------------------------------------------

    async def store_finding(self, finding: Finding, project_id: str = "temp") -> None:
        import json as _json
        await self._db.execute(
            """
            INSERT OR REPLACE INTO findings
                (id, title, severity, type, host, request_id, source, status, description, evidence, created_at, project_id)
            VALUES
                (:id, :title, :severity, :type, :host, :request_id, :source, :status, :description, :evidence, :created_at, :project_id)
            """,
            {
                "id": finding.id,
                "title": finding.title,
                "severity": finding.severity,
                "type": finding.type,
                "host": finding.host,
                "request_id": finding.request_id,
                "source": finding.source,
                "status": finding.status,
                "description": finding.description,
                "evidence": finding.evidence,
                "created_at": finding.created_at.isoformat(),
                "project_id": project_id,
            },
        )
        await self._db.commit()

    async def get_findings(
        self,
        severity: Optional[str] = None,
        host: Optional[str] = None,
        type_: Optional[str] = None,
        source: Optional[str] = None,
        status: Optional[str] = None,
        project_id: str = "temp",
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM findings WHERE project_id = ?"
        params: list = [project_id]
        if severity:
            sql += " AND severity = ?"
            params.append(severity)
        if host:
            sql += " AND host LIKE ?"
            params.append(f"%{host}%")
        if type_:
            sql += " AND type = ?"
            params.append(type_)
        if source:
            sql += " AND source = ?"
            params.append(source)
        if status:
            sql += " AND status = ?"
            params.append(status)
        sql += " ORDER BY created_at DESC"
        async with self._db.execute(sql, params) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def update_finding_status(self, finding_id: str, status: str) -> bool:
        async with self._db.execute(
            "UPDATE findings SET status = ? WHERE id = ?", (status, finding_id)
        ) as cur:
            changed = cur.rowcount
        await self._db.commit()
        return changed > 0

    async def delete_finding(self, finding_id: str) -> bool:
        async with self._db.execute(
            "DELETE FROM findings WHERE id = ?", (finding_id,)
        ) as cur:
            changed = cur.rowcount
        await self._db.commit()
        return changed > 0

    # ------------------------------------------------------------------
    # Chat Sessions CRUD
    # ------------------------------------------------------------------

    async def create_chat_session(self, session: ChatSession) -> None:
        import json as _json
        _enabled = getattr(session, "enabled_tools", None)
        _workspace_id = getattr(session, "workspace_id", None) or session.__dict__.get("workspace_id")
        await self._db.execute(
            """
            INSERT INTO chat_sessions
                (id, name, scope, scope_data, workspace_dir, workspace_id, target_url, plan_id, hunt_status, enabled_tools, created_at, project_id)
            VALUES
                (:id, :name, :scope, :scope_data, :workspace_dir, :workspace_id, :target_url, :plan_id, :hunt_status, :enabled_tools, :created_at, :project_id)
            """,
            {
                "id": session.id,
                "name": session.name,
                "scope": session.scope,
                "scope_data": _json.dumps(session.scope_data) if session.scope_data else None,
                "workspace_dir": session.workspace_dir,
                "workspace_id": _workspace_id,
                "target_url": getattr(session, "target_url", "") or "",
                "plan_id": getattr(session, "plan_id", "") or "",
                "hunt_status": getattr(session, "hunt_status", "idle") or "idle",
                "enabled_tools": _json.dumps(_enabled) if _enabled is not None else None,
                "created_at": session.created_at.isoformat(),
                "project_id": session.project_id,
            },
        )
        await self._db.commit()

    @staticmethod
    def _deserialise_session(row) -> Dict[str, Any]:
        """Convert a raw DB row to a dict, deserialising JSON-encoded columns."""
        import json as _json
        d = dict(row)
        for col in ("scope_data", "enabled_tools"):
            if isinstance(d.get(col), str):
                try:
                    d[col] = _json.loads(d[col])
                except Exception:
                    pass
        return d

    async def get_chat_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Return a single chat session by ID, or None if not found."""
        async with self._db.execute(
            "SELECT * FROM chat_sessions WHERE id = ?", (session_id,)
        ) as cur:
            row = await cur.fetchone()
        return self._deserialise_session(row) if row else None

    async def get_chat_sessions(self, project_id: str = "temp") -> List[Dict[str, Any]]:
        async with self._db.execute(
            "SELECT * FROM chat_sessions WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,),
        ) as cur:
            rows = await cur.fetchall()
        return [self._deserialise_session(r) for r in rows]

    async def update_chat_session(self, session_id: str, updates: dict) -> bool:
        """Apply a partial update to a chat session. Allowed keys: name, scope, scope_data, enabled_tools."""
        import json as _json
        allowed = {"name", "scope", "scope_data", "enabled_tools"}
        filtered = {k: v for k, v in updates.items() if k in allowed}
        if not filtered:
            return False
        # scope_data and enabled_tools must be JSON-serialised
        if "scope_data" in filtered:
            filtered["scope_data"] = _json.dumps(filtered["scope_data"]) if filtered["scope_data"] else None
        if "enabled_tools" in filtered:
            v = filtered["enabled_tools"]
            filtered["enabled_tools"] = _json.dumps(v) if v is not None else None
        set_clause = ", ".join(f"{k} = :{k}" for k in filtered)
        filtered["session_id"] = session_id
        async with self._db.execute(
            f"UPDATE chat_sessions SET {set_clause} WHERE id = :session_id",
            filtered,
        ) as cur:
            changed = cur.rowcount
        await self._db.commit()
        return changed > 0

    async def delete_chat_session(self, session_id: str) -> bool:
        async with self._db.execute(
            "DELETE FROM chat_sessions WHERE id = ?", (session_id,)
        ) as cur:
            changed = cur.rowcount
        await self._db.commit()
        # Also delete associated chat messages
        await self._db.execute(
            "DELETE FROM chat_messages WHERE request_id = ?", (session_id,)
        )
        await self._db.commit()
        return changed > 0

    async def get_chat_history(self, session_id: str) -> List[Dict[str, Any]]:
        """Return chat messages for a session (alias for get_chat_messages)."""
        return await self.get_chat_messages(session_id)  # type: ignore[attr-defined]

    async def append_chat_message(self, session_id: str, message: Dict[str, Any]) -> None:
        """Append a single chat message for a session."""
        await self.save_chat_messages(session_id, [message])  # type: ignore[attr-defined]

    # ------------------------------------------------------------------
    # Workspaces CRUD
    # ------------------------------------------------------------------

    async def create_workspace(self, workspace: "Workspace") -> None:
        await self._db.execute(
            """
            INSERT INTO workspaces (id, project_id, parent_id, name, status, http_status, created_at)
            VALUES (:id, :project_id, :parent_id, :name, :status, :http_status, :created_at)
            """,
            {
                "id": workspace.id,
                "project_id": workspace.project_id,
                "parent_id": workspace.parent_id,
                "name": workspace.name,
                "status": workspace.status,
                "http_status": workspace.http_status,
                "created_at": workspace.created_at.isoformat(),
            },
        )
        await self._db.commit()

    async def update_workspace_status(self, workspace_id: str, status: str) -> None:
        await self._db.execute(
            "UPDATE workspaces SET status = ? WHERE id = ?",
            (status, workspace_id),
        )
        await self._db.commit()

    async def update_workspace_http_status(self, workspace_id: str, http_status: Optional[int]) -> None:
        await self._db.execute(
            "UPDATE workspaces SET http_status = ? WHERE id = ?",
            (http_status, workspace_id),
        )
        await self._db.commit()

    async def get_workspaces(self, project_id: str = "temp") -> List[Dict[str, Any]]:
        """Return all workspaces for a project, with run and hunt counts."""
        async with self._db.execute(
            """
            SELECT w.*,
                   (SELECT COUNT(*) FROM runs r WHERE r.workspace_id = w.id) AS run_count,
                   (SELECT COUNT(*) FROM chat_sessions cs WHERE cs.workspace_id = w.id) AS hunt_count
            FROM workspaces w
            WHERE w.project_id = ?
            ORDER BY w.created_at DESC
            """,
            (project_id,),
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def get_workspace(self, workspace_id: str) -> Optional[Dict[str, Any]]:
        async with self._db.execute(
            """
            SELECT w.*,
                   (SELECT COUNT(*) FROM runs r WHERE r.workspace_id = w.id) AS run_count,
                   (SELECT COUNT(*) FROM chat_sessions cs WHERE cs.workspace_id = w.id) AS hunt_count
            FROM workspaces w
            WHERE w.id = ?
            """,
            (workspace_id,),
        ) as cur:
            row = await cur.fetchone()
        return dict(row) if row else None

    async def delete_workspace(self, workspace_id: str) -> bool:
        async with self._db.execute(
            "DELETE FROM workspaces WHERE id = ?", (workspace_id,)
        ) as cur:
            changed = cur.rowcount
        await self._db.commit()
        return changed > 0

    # ------------------------------------------------------------------
    # Runners CRUD
    # ------------------------------------------------------------------

    async def register_runner_heartbeat(self, runner_id: str, url: Optional[str] = None, logs: Optional[str] = None) -> None:
        now_str = datetime.utcnow().isoformat()
        # Insert or update runner status/last_heartbeat
        await self._db.execute(
            """
            INSERT INTO runners (id, url, status, last_heartbeat, logs)
            VALUES (?, ?, 'active', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                url = excluded.url,
                status = 'active',
                last_heartbeat = excluded.last_heartbeat,
                logs = COALESCE(excluded.logs, runners.logs)
            """,
            (runner_id, url, now_str, logs),
        )
        await self._db.commit()

    async def register_provisioning_runner(self, runner_id: str) -> None:
        """Pre-register a runner as 'provisioning' immediately when the ECS task is spawned,
        before it has booted and sent its first heartbeat. This prevents the spawning storm
        by letting the active-count ceiling see the runner immediately."""
        now_str = datetime.utcnow().isoformat()
        await self._db.execute(
            """
            INSERT INTO runners (id, status, last_heartbeat)
            VALUES (?, 'provisioning', ?)
            ON CONFLICT(id) DO UPDATE SET
                status = 'provisioning',
                last_heartbeat = excluded.last_heartbeat
            """,
            (runner_id, now_str),
        )
        await self._db.commit()

    async def get_active_runners(self, timeout_seconds: int = 30) -> List[Dict[str, Any]]:
        """Retrieve all registered runners with dynamically computed status.
        Provisioning runners are treated as active for up to 5 minutes to cover ECS cold-start time."""
        now = datetime.utcnow()
        limit_time = (now - timedelta(seconds=timeout_seconds)).isoformat()
        provisioning_limit_time = (now - timedelta(minutes=5)).isoformat()
        async with self._db.execute("SELECT * FROM runners") as cur:
            rows = await cur.fetchall()

        runners = []
        for r in rows:
            rd = dict(r)
            if rd.get("status") == "provisioning":
                # Provisioning runners are considered live for up to 5 minutes (ECS boot time)
                if rd["last_heartbeat"] < provisioning_limit_time:
                    rd["status"] = "offline"
            else:
                if rd["last_heartbeat"] < limit_time:
                    rd["status"] = "offline"
            runners.append(rd)
        return runners

    async def update_runner_status(self, runner_id: str, status: str) -> None:
        if status == "offline":
            await self._db.execute(
                "UPDATE runners SET status = ?, last_heartbeat = '1970-01-01T00:00:00' WHERE id = ?",
                (status, runner_id),
            )
        else:
            await self._db.execute(
                "UPDATE runners SET status = ? WHERE id = ?",
                (status, runner_id),
            )
        await self._db.commit()

    async def create_runner_key(self, key: str, name: str) -> None:
        now_str = datetime.utcnow().isoformat()
        await self._db.execute(
            "INSERT INTO runner_keys (key, name, status, created_at) VALUES (?, ?, 'active', ?)",
            (key, name, now_str),
        )
        await self._db.commit()

    async def get_runner_keys(self) -> List[Dict[str, Any]]:
        async with self._db.execute("SELECT * FROM runner_keys ORDER BY created_at DESC") as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def delete_runner_key(self, key: str) -> bool:
        async with self._db.execute("DELETE FROM runner_keys WHERE key = ?", (key,)) as cur:
            changed = cur.rowcount
        await self._db.commit()
        return changed > 0

    async def validate_runner_key(self, key: str) -> bool:
        async with self._db.execute("SELECT 1 FROM runner_keys WHERE key = ? AND status = 'active'", (key,)) as cur:
            row = await cur.fetchone()
        return row is not None

    # ------------------------------------------------------------------
    # Runs CRUD
    # ------------------------------------------------------------------

    async def create_run(self, run: "Run") -> None:
        import json as _json
        follow_on_plan_ids = getattr(run, "follow_on_plan_ids", None) or []
        follow_on_path_plan_ids = getattr(run, "follow_on_path_plan_ids", None) or []
        den_id = getattr(run, "den_id", "local") or "local"
        await self._db.execute(
            """
            INSERT INTO runs
                (id, workspace_id, project_id, plan_id, target_url, status,
                 exit_code, run_log_path, started_at, finished_at, created_at,
                 follow_on_plan_id, follow_on_path_plan_id, den_id,
                 script, interpreter, timeout)
            VALUES
                (:id, :workspace_id, :project_id, :plan_id, :target_url, :status,
                 :exit_code, :run_log_path, :started_at, :finished_at, :created_at,
                 :follow_on_plan_id, :follow_on_path_plan_id, :den_id,
                 :script, :interpreter, :timeout)
            """,
            {
                "id": run.id,
                "workspace_id": run.workspace_id,
                "project_id": run.project_id,
                "plan_id": run.plan_id,
                "target_url": run.target_url,
                "status": run.status,
                "exit_code": run.exit_code,
                "run_log_path": run.run_log_path,
                "started_at": run.started_at.isoformat() if run.started_at else None,
                "finished_at": run.finished_at.isoformat() if run.finished_at else None,
                "created_at": run.created_at.isoformat(),
                # Store as JSON arrays
                "follow_on_plan_id": _json.dumps(follow_on_plan_ids) if follow_on_plan_ids else None,
                "follow_on_path_plan_id": _json.dumps(follow_on_path_plan_ids) if follow_on_path_plan_ids else None,
                "den_id": den_id,
                "script": getattr(run, "script", None),
                "interpreter": getattr(run, "interpreter", None),
                "timeout": getattr(run, "timeout", None),
            },
        )
        await self._db.commit()

        try:
            from routers.runners import notify_new_run
            notify_new_run(den_id)
        except Exception:
            pass

    @staticmethod
    def _deserialise_run(row) -> Dict[str, Any]:
        """Convert a raw DB run row to a dict, deserialising follow_on_plan_ids."""
        import json as _json

        def _parse_ids(raw) -> list:
            if raw is None:
                return []
            if isinstance(raw, list):
                return raw
            try:
                parsed = _json.loads(raw)
                return parsed if isinstance(parsed, list) else [parsed]
            except Exception:
                return [raw] if raw else []

        d = dict(row)
        d["follow_on_plan_ids"] = _parse_ids(d.pop("follow_on_plan_id", None))
        d["follow_on_path_plan_ids"] = _parse_ids(d.pop("follow_on_path_plan_id", None))
        return d

    async def get_runs(
        self,
        workspace_id: Optional[str] = None,
        project_id: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        if workspace_id:
            sql = "SELECT * FROM runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?"
            params: list = [workspace_id, limit]
        elif project_id:
            sql = "SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
            params = [project_id, limit]
        else:
            sql = "SELECT * FROM runs ORDER BY created_at DESC LIMIT ?"
            params = [limit]
        async with self._db.execute(sql, params) as cur:
            rows = await cur.fetchall()
        return [self._deserialise_run(r) for r in rows]

    async def get_run(self, run_id: str) -> Optional[Dict[str, Any]]:
        async with self._db.execute(
            "SELECT * FROM runs WHERE id = ?", (run_id,)
        ) as cur:
            row = await cur.fetchone()
        return self._deserialise_run(row) if row else None

    async def update_run_status(
        self,
        run_id: str,
        status: str,
        exit_code: Optional[int] = None,
        run_log_path: Optional[str] = None,
        started_at: Optional[datetime] = None,
        finished_at: Optional[datetime] = None,
    ) -> bool:
        fields: dict = {"status": status}
        if exit_code is not None:
            fields["exit_code"] = exit_code
        if run_log_path is not None:
            fields["run_log_path"] = run_log_path
        if started_at is not None:
            fields["started_at"] = started_at.isoformat()
        if finished_at is not None:
            fields["finished_at"] = finished_at.isoformat()
        set_clause = ", ".join(f"{k} = :{k}" for k in fields)
        fields["run_id"] = run_id
        async with self._db.execute(
            f"UPDATE runs SET {set_clause} WHERE id = :run_id", fields
        ) as cur:
            changed = cur.rowcount
        await self._db.commit()
        return changed > 0

    async def delete_run(self, run_id: str) -> bool:
        async with self._db.execute(
            "DELETE FROM runs WHERE id = ?", (run_id,)
        ) as cur:
            changed = cur.rowcount
        await self._db.commit()
        return changed > 0

    async def get_busy_runner_count_for_den(self, den_id: str) -> int:
        """Count how many runs are currently in 'running' state for the given den.
        Used to determine whether idle warm runners already exist before spawning new ones."""
        async with self._db.execute(
            "SELECT COUNT(*) FROM runs WHERE status = 'running' AND COALESCE(den_id, 'local') = ?",
            (den_id,)
        ) as cur:
            row = await cur.fetchone()
        return row[0] if row else 0

    async def get_live_runner_count_for_den(self, den_id: str, timeout_seconds: int = 30) -> int:
        """Count the active or provisioning runners for a specific Den to prevent duplicate spawning."""
        active_runners = await self.get_active_runners(timeout_seconds=timeout_seconds)
        return len([
            r for r in active_runners
            if r["id"].startswith(f"runner-fargate-{den_id}-")
            and r.get("status") in ("active", "provisioning")
        ])

    async def lease_pending_run(self, runner_id: str) -> Optional[Dict[str, Any]]:
        """Atomically find the oldest pending run matching the runner's Den ID configuration, assigning it to the runner and setting status to 'running'."""
        _log.debug("[RUNNER_LEASE] [START] Runner ID %s polling for runs", runner_id)
        if not hasattr(self, "_lease_lock"):
            self._lease_lock = asyncio.Lock()
        async with self._lease_lock:
            return await self._lease_pending_run_locked(runner_id)

    async def _lease_pending_run_locked(self, runner_id: str) -> Optional[Dict[str, Any]]:
        """Inner lease logic — must only be called while holding self._lease_lock."""
        await self._db.execute("BEGIN IMMEDIATE")
        try:
            # Check if this runner belongs to a specific Den ID. If the runner_id starts with a den-specific prefix or we default to local.
            # Local dev runner keys or standard runner registrations will ask for jobs belonging to 'local'.
            # A runner_id of format 'runner-fargate-{den_id}-...' identifies its Fargate Den. Let's parse den_id from runner_id if present:
            target_den = "local"
            if "runner-fargate-" in runner_id:
                parts = runner_id.split("-")
                # Format is: runner-fargate-{den_id}-{uuid}
                if len(parts) >= 4:
                    target_den = parts[2]

            _log.debug("[RUNNER_LEASE] Runner ID %s parsed as targeting Den ID: %s", runner_id, target_den)

            async with self._db.execute(
                "SELECT * FROM runs WHERE status = 'pending' AND COALESCE(den_id, 'local') = ? ORDER BY created_at ASC LIMIT 1",
                (target_den,)
            ) as cur:
                row = await cur.fetchone()
            if not row:
                _log.debug("[RUNNER_LEASE] [NO_JOBS] No pending runs found for Den ID: %s", target_den)
                await self._db.commit()
                return None
            
            run_id = row["id"]
            _log.info("[RUNNER_LEASE] [FOUND_JOB] Runner ID %s found pending Run ID %s for Den ID: %s", runner_id, run_id, target_den)
            now_str = datetime.utcnow().isoformat()
            
            await self._db.execute(
                "UPDATE runs SET status = 'running', started_at = ?, runner_id = ? WHERE id = ?",
                (now_str, runner_id, run_id),
            )
            await self._db.commit()
            
            async with self._db.execute("SELECT * FROM runs WHERE id = ?", (run_id,)) as cur:
                updated_row = await cur.fetchone()
            
            _log.info("[RUNNER_LEASE] [SUCCESS] Atomically leased Run ID %s to Runner ID %s", run_id, runner_id)
            return self._deserialise_run(updated_row) if updated_row else None
        except Exception as e:
            _log.error("[RUNNER_LEASE] [FAILED] Transaction rolled back due to error: %s", e)
            await self._db.rollback()
            raise

    # ------------------------------------------------------------------
    # Test Runs CRUD
    # ------------------------------------------------------------------

    async def store_test_run(self, run: TestRun) -> None:
        await self._db.execute(
            """
            INSERT OR REPLACE INTO test_runs
                (id, file, test_name, host, via_proxy, status, output, started_at, finished_at, project_id)
            VALUES
                (:id, :file, :test_name, :host, :via_proxy, :status, :output, :started_at, :finished_at, :project_id)
            """,
            {
                "id": run.id,
                "file": run.file,
                "test_name": run.test_name,
                "host": run.host,
                "via_proxy": int(run.via_proxy),
                "status": run.status,
                "output": run.output,
                "started_at": run.started_at.isoformat() if run.started_at else None,
                "finished_at": run.finished_at.isoformat() if run.finished_at else None,
                "project_id": run.project_id,
            },
        )
        await self._db.commit()

    async def get_test_runs(
        self,
        file: Optional[str] = None,
        limit: int = 50,
        project_id: str = "temp",
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM test_runs WHERE project_id = ?"
        params: list = [project_id]
        if file:
            sql += " AND file = ?"
            params.append(file)
        sql += " ORDER BY started_at DESC LIMIT ?"
        params.append(limit)
        async with self._db.execute(sql, params) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def update_test_run(self, run_id: str, status: str, output: str, finished_at: datetime) -> None:
        await self._db.execute(
            "UPDATE test_runs SET status = ?, output = ?, finished_at = ? WHERE id = ?",
            (status, output, finished_at.isoformat(), run_id),
        )
        await self._db.commit()

    # ------------------------------------------------------------------
    # Projects CRUD
    # ------------------------------------------------------------------

    async def create_project(self, project: Project) -> None:
        import json as _json
        await self._db.execute(
            """
            INSERT INTO projects
                (id, name, description, color, emoji, labels, default_model, is_temp, created_at, updated_at)
            VALUES
                (:id, :name, :description, :color, :emoji, :labels, :default_model, :is_temp, :created_at, :updated_at)
            """,
            {
                "id": project.id,
                "name": project.name,
                "description": project.description,
                "color": project.color,
                "emoji": project.emoji,
                "labels": _json.dumps(project.labels),
                "default_model": project.default_model,
                "is_temp": int(project.is_temp),
                "created_at": project.created_at.isoformat(),
                "updated_at": project.updated_at.isoformat(),
            },
        )
        await self._db.commit()

    async def get_projects(self) -> List[Dict[str, Any]]:
        async with self._db.execute(
            "SELECT * FROM projects ORDER BY created_at ASC"
        ) as cur:
            rows = await cur.fetchall()
        return [self._project_from_row(r) for r in rows]

    async def get_project(self, project_id: str) -> Optional[Dict[str, Any]]:
        async with self._db.execute(
            "SELECT * FROM projects WHERE id = ?", (project_id,)
        ) as cur:
            row = await cur.fetchone()
        return self._project_from_row(row) if row else None

    async def update_project(self, project_id: str, updates: dict) -> bool:
        """Apply a partial update to a project. Returns True if a row was changed."""
        import json as _json
        if not updates:
            return False
        # Serialise labels list → JSON string before writing to SQLite
        if "labels" in updates and isinstance(updates["labels"], list):
            updates = {**updates, "labels": _json.dumps(updates["labels"])}
        now = datetime.utcnow().isoformat()
        set_clauses = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [now, project_id]
        async with self._db.execute(
            f"UPDATE projects SET {set_clauses}, updated_at = ? WHERE id = ?",
            values,
        ) as cur:
            changed = cur.rowcount
        await self._db.commit()
        return changed > 0

    async def delete_project(self, project_id: str) -> bool:
        """
        Cascade-delete all child data then delete the project.
        Returns False (and does nothing) if project_id == 'temp'.

        The requests_ad trigger on the requests table automatically removes
        matching rows from requests_fts when a request is deleted, so we do
        NOT touch requests_fts directly here — doing so would corrupt the FTS
        index for other projects.
        """
        if project_id == "temp":
            return False

        # Delete requests one-by-one so the AFTER DELETE trigger fires for
        # each row and keeps requests_fts consistent.
        async with self._db.execute(
            "SELECT rowid FROM requests WHERE project_id = ?", (project_id,)
        ) as cur:
            rowids = [row[0] for row in await cur.fetchall()]

        for rowid in rowids:
            await self._db.execute(
                "DELETE FROM requests WHERE rowid = ?", (rowid,)
            )

        await self._db.execute(
            "DELETE FROM findings WHERE project_id = ?", (project_id,)
        )
        await self._db.execute(
            "DELETE FROM chat_sessions WHERE project_id = ?", (project_id,)
        )
        await self._db.execute(
            "DELETE FROM test_runs WHERE project_id = ?", (project_id,)
        )
        await self._db.execute(
            "DELETE FROM project_api_keys WHERE project_id = ?", (project_id,)
        )
        await self._db.execute(
            "DELETE FROM spend_snapshots WHERE project_id = ?", (project_id,)
        )
        await self._db.execute(
            "DELETE FROM projects WHERE id = ?", (project_id,)
        )
        await self._db.commit()

        # Verify the project row was actually deleted
        async with self._db.execute(
            "SELECT COUNT(*) FROM projects WHERE id = ?", (project_id,)
        ) as cur:
            remaining = (await cur.fetchone())[0]
        return remaining == 0

    async def reset_temp_project(self) -> None:
        """Clear all child data associated with the 'temp' project, leaving only the project row itself."""
        await self.clear_all_requests(project_id="temp")
        await self._db.execute("DELETE FROM findings WHERE project_id = 'temp'")
        await self._db.execute("DELETE FROM chat_sessions WHERE project_id = 'temp'")
        await self._db.execute("DELETE FROM test_runs WHERE project_id = 'temp'")
        await self._db.execute("DELETE FROM project_api_keys WHERE project_id = 'temp'")
        await self._db.execute("DELETE FROM spend_snapshots WHERE project_id = 'temp'")
        await self._db.commit()

    async def promote_temp_project(self, new_name: str, new_id: str) -> "Project":
        """
        Copy the 'temp' project's data into a new permanent project.

        The temp project is left intact (its rows remain under project_id='temp').
        All requests, findings, chat_sessions, and test_runs are duplicated with
        fresh UUIDs under the new project_id so both projects are independent.
        """
        import uuid as _uuid

        now = datetime.utcnow().isoformat()

        # Fetch temp project metadata for defaults
        temp = await self.get_project("temp")

        new_project = Project(
            id=new_id,
            name=new_name,
            description=(temp or {}).get("description", ""),
            color=(temp or {}).get("color", "#f97316"),
            emoji=(temp or {}).get("emoji", ""),
            labels=(temp or {}).get("labels", []),
            default_model=(temp or {}).get("default_model", "x-ai/grok-4.3"),
            is_temp=False,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        await self.create_project(new_project)

        # Copy requests (new IDs, new project_id)
        async with self._db.execute(
            "SELECT * FROM requests WHERE project_id = 'temp' ORDER BY timestamp ASC"
        ) as cur:
            temp_requests = [dict(r) for r in await cur.fetchall()]

        id_map: Dict[str, str] = {}  # old_id -> new_id for FK remapping
        for req in temp_requests:
            old_id = req["id"]
            new_req_id = str(_uuid.uuid4())
            id_map[old_id] = new_req_id
            req["id"] = new_req_id
            req["project_id"] = new_id
            req.setdefault("annotation", None)
            req.setdefault("source", "proxy")
            try:
                await self._db.execute(
                    """
                    INSERT OR IGNORE INTO requests (
                        id, timestamp, method, url, host, path,
                        query_params, headers, body, content_type, content_length,
                        status_code, response_headers, response_body,
                        response_time, response_size,
                        client_ip, server_ip, tls_version, intercepted, modified,
                        annotation, source, project_id
                    ) VALUES (
                        :id, :timestamp, :method, :url, :host, :path,
                        :query_params, :headers, :body, :content_type, :content_length,
                        :status_code, :response_headers, :response_body,
                        :response_time, :response_size,
                        :client_ip, :server_ip, :tls_version, :intercepted, :modified,
                        :annotation, :source, :project_id
                    )
                    """,
                    req,
                )
            except Exception:
                pass

        # Copy findings
        async with self._db.execute(
            "SELECT * FROM findings WHERE project_id = 'temp' ORDER BY created_at ASC"
        ) as cur:
            temp_findings = [dict(r) for r in await cur.fetchall()]

        for f in temp_findings:
            f["id"] = str(_uuid.uuid4())
            f["project_id"] = new_id
            if f.get("request_id") and f["request_id"] in id_map:
                f["request_id"] = id_map[f["request_id"]]
            try:
                await self._db.execute(
                    """
                    INSERT OR IGNORE INTO findings
                        (id, title, severity, type, host, request_id, source, status,
                         description, evidence, created_at, project_id)
                    VALUES
                        (:id, :title, :severity, :type, :host, :request_id, :source, :status,
                         :description, :evidence, :created_at, :project_id)
                    """,
                    f,
                )
            except Exception:
                pass

        # Copy chat sessions
        async with self._db.execute(
            "SELECT * FROM chat_sessions WHERE project_id = 'temp' ORDER BY created_at ASC"
        ) as cur:
            temp_sessions = [dict(r) for r in await cur.fetchall()]

        for cs in temp_sessions:
            cs["id"] = str(_uuid.uuid4())
            cs["project_id"] = new_id
            try:
                await self._db.execute(
                    """
                    INSERT OR IGNORE INTO chat_sessions
                        (id, name, scope, scope_data, created_at, project_id)
                    VALUES
                        (:id, :name, :scope, :scope_data, :created_at, :project_id)
                    """,
                    cs,
                )
            except Exception:
                pass

        # Copy test runs
        async with self._db.execute(
            "SELECT * FROM test_runs WHERE project_id = 'temp' ORDER BY started_at ASC"
        ) as cur:
            temp_runs = [dict(r) for r in await cur.fetchall()]

        for tr in temp_runs:
            tr["id"] = str(_uuid.uuid4())
            tr["project_id"] = new_id
            try:
                await self._db.execute(
                    """
                    INSERT OR IGNORE INTO test_runs
                        (id, file, test_name, host, via_proxy, status, output,
                         started_at, finished_at, project_id)
                    VALUES
                        (:id, :file, :test_name, :host, :via_proxy, :status, :output,
                         :started_at, :finished_at, :project_id)
                    """,
                    tr,
                )
            except Exception:
                pass

        await self._db.commit()
        return new_project

    async def export_project(self, project_id: str) -> Optional[Dict[str, Any]]:
        """Return a dict suitable for ProjectExport, or None if project not found."""
        project = await self.get_project(project_id)
        if not project:
            return None

        async with self._db.execute(
            "SELECT * FROM requests WHERE project_id = ? ORDER BY timestamp ASC",
            (project_id,),
        ) as cur:
            requests = [dict(r) for r in await cur.fetchall()]

        async with self._db.execute(
            "SELECT * FROM findings WHERE project_id = ? ORDER BY created_at ASC",
            (project_id,),
        ) as cur:
            findings = [dict(r) for r in await cur.fetchall()]

        async with self._db.execute(
            "SELECT * FROM chat_sessions WHERE project_id = ? ORDER BY created_at ASC",
            (project_id,),
        ) as cur:
            chat_sessions = [dict(r) for r in await cur.fetchall()]

        async with self._db.execute(
            "SELECT * FROM test_runs WHERE project_id = ? ORDER BY started_at ASC",
            (project_id,),
        ) as cur:
            test_runs = [dict(r) for r in await cur.fetchall()]

        return {
            "project": project,
            "requests": requests,
            "findings": findings,
            "chat_sessions": chat_sessions,
            "test_runs": test_runs,
        }

    async def import_project(self, data: dict) -> Project:
        """
        Import a ProjectExport payload.  Creates a new project with a fresh UUID
        and re-inserts all child rows under the new project_id.
        """
        import uuid as _uuid

        new_id = str(_uuid.uuid4())

        src_project = data.get("project", {})
        new_project = Project(
            id=new_id,
            name=src_project.get("name", "Imported Project"),
            description=src_project.get("description", ""),
            color=src_project.get("color", "#f97316"),
            is_temp=False,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        await self.create_project(new_project)

        # Re-insert requests
        for req in data.get("requests", []):
            req = dict(req)
            req["project_id"] = new_id
            req.setdefault("annotation", None)
            req.setdefault("source", "proxy")
            try:
                await self._db.execute(
                    """
                    INSERT OR IGNORE INTO requests (
                        id, timestamp, method, url, host, path,
                        query_params, headers, body, content_type, content_length,
                        status_code, response_headers, response_body,
                        response_time, response_size,
                        client_ip, server_ip, tls_version, intercepted, modified,
                        annotation, source, project_id
                    ) VALUES (
                        :id, :timestamp, :method, :url, :host, :path,
                        :query_params, :headers, :body, :content_type, :content_length,
                        :status_code, :response_headers, :response_body,
                        :response_time, :response_size,
                        :client_ip, :server_ip, :tls_version, :intercepted, :modified,
                        :annotation, :source, :project_id
                    )
                    """,
                    req,
                )
            except Exception:
                pass  # skip malformed rows

        # Re-insert findings
        for f in data.get("findings", []):
            f = dict(f)
            f["project_id"] = new_id
            try:
                await self._db.execute(
                    """
                    INSERT OR IGNORE INTO findings
                        (id, title, severity, type, host, request_id, source, status,
                         description, evidence, created_at, project_id)
                    VALUES
                        (:id, :title, :severity, :type, :host, :request_id, :source, :status,
                         :description, :evidence, :created_at, :project_id)
                    """,
                    f,
                )
            except Exception:
                pass

        # Re-insert chat sessions
        for cs in data.get("chat_sessions", []):
            cs = dict(cs)
            cs["project_id"] = new_id
            try:
                await self._db.execute(
                    """
                    INSERT OR IGNORE INTO chat_sessions
                        (id, name, scope, scope_data, created_at, project_id)
                    VALUES
                        (:id, :name, :scope, :scope_data, :created_at, :project_id)
                    """,
                    cs,
                )
            except Exception:
                pass

        # Re-insert test runs
        for tr in data.get("test_runs", []):
            tr = dict(tr)
            tr["project_id"] = new_id
            try:
                await self._db.execute(
                    """
                    INSERT OR IGNORE INTO test_runs
                        (id, file, test_name, host, via_proxy, status, output,
                         started_at, finished_at, project_id)
                    VALUES
                        (:id, :file, :test_name, :host, :via_proxy, :status, :output,
                         :started_at, :finished_at, :project_id)
                    """,
                    tr,
                )
            except Exception:
                pass

        await self._db.commit()
        return new_project

    @staticmethod
    def _project_from_row(row: aiosqlite.Row) -> Dict[str, Any]:
        import json as _json
        d = dict(row)
        d["is_temp"] = bool(d.get("is_temp", 0))
        d["emoji"] = d.get("emoji") or ""
        d["default_model"] = d.get("default_model") or None
        raw_labels = d.get("labels") or "[]"
        try:
            d["labels"] = _json.loads(raw_labels) if isinstance(raw_labels, str) else raw_labels
        except Exception:
            d["labels"] = []
        return d

    # ------------------------------------------------------------------
    # Project API Keys CRUD
    # ------------------------------------------------------------------

    async def store_project_api_key(self, key: ProjectApiKey, key_value: str) -> None:
        """Persist a provisioned OpenRouter key record (including the raw key value)."""
        await self._db.execute(
            """
            INSERT OR REPLACE INTO project_api_keys
                (id, project_id, name, key_hash, key_preview, key_value, limit_usd, created_at)
            VALUES
                (:id, :project_id, :name, :key_hash, :key_preview, :key_value, :limit_usd, :created_at)
            """,
            {
                "id": key.id,
                "project_id": key.project_id,
                "name": key.name,
                "key_hash": key.key_hash,
                "key_preview": key.key_preview,
                "key_value": key_value,
                "limit_usd": key.limit_usd,
                "created_at": key.created_at,
            },
        )
        await self._db.commit()

    async def get_project_api_keys(self, project_id: str) -> List[Dict]:
        """Return all API keys for a project, ordered newest first (no key_value)."""
        async with self._db.execute(
            "SELECT id, project_id, name, key_hash, key_preview, limit_usd, created_at "
            "FROM project_api_keys WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,),
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def get_project_api_keys_with_values(self, project_id: str) -> List[Dict]:
        """Return all API keys for a project including key_value (for internal spend checks)."""
        async with self._db.execute(
            "SELECT id, project_id, name, key_hash, key_preview, key_value, limit_usd, created_at "
            "FROM project_api_keys WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,),
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def get_project_api_key_by_hash(self, key_hash: str) -> Optional[Dict]:
        """Return a single key record by its OR hash (includes key_value)."""
        async with self._db.execute(
            "SELECT * FROM project_api_keys WHERE key_hash = ?", (key_hash,)
        ) as cur:
            row = await cur.fetchone()
        return dict(row) if row else None

    async def get_project_api_key_by_id(self, key_id: str) -> Optional[Dict]:
        """Return a single key record by its DB id (includes key_value)."""
        async with self._db.execute(
            "SELECT * FROM project_api_keys WHERE id = ?", (key_id,)
        ) as cur:
            row = await cur.fetchone()
        return dict(row) if row else None

    async def delete_project_api_key(self, key_id: str) -> bool:
        """Delete a key by its DB id. Returns True if a row was deleted."""
        async with self._db.execute(
            "DELETE FROM project_api_keys WHERE id = ?", (key_id,)
        ) as cur:
            changed = cur.rowcount
        await self._db.commit()
        return changed > 0

    async def get_active_key_for_project(self, project_id: str) -> Optional[str]:
        """Return the key_value of the most recently created key for the project, or None."""
        async with self._db.execute(
            "SELECT key_value FROM project_api_keys "
            "WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
            (project_id,),
        ) as cur:
            row = await cur.fetchone()
        return row["key_value"] if row else None

    # ------------------------------------------------------------------
    # Spend Snapshots
    # ------------------------------------------------------------------

    async def store_spend_snapshot(
        self,
        project_id: str,
        key_hash: str,
        usage_usd: float,
        limit_usd: Optional[float],
        snapshot_at: str,
    ) -> None:
        """Persist a spend snapshot for a key."""
        await self._db.execute(
            """
            INSERT INTO spend_snapshots (id, project_id, key_hash, usage_usd, limit_usd, snapshot_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (str(uuid.uuid4()), project_id, key_hash, usage_usd, limit_usd, snapshot_at),
        )
        await self._db.commit()

    async def get_latest_spend_snapshots(self, project_id: str) -> List[Dict]:
        """Return the most recent snapshot per key_hash for a project."""
        async with self._db.execute(
            """
            SELECT s.*
            FROM spend_snapshots s
            INNER JOIN (
                SELECT key_hash, MAX(snapshot_at) AS max_at
                FROM spend_snapshots
                WHERE project_id = ?
                GROUP BY key_hash
            ) latest ON s.key_hash = latest.key_hash AND s.snapshot_at = latest.max_at
            WHERE s.project_id = ?
            ORDER BY s.snapshot_at DESC
            """,
            (project_id, project_id),
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------------
    # Settings CRUD
    # ------------------------------------------------------------------

    async def get_setting(self, key: str) -> Optional[str]:
        async with self._db.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ) as cur:
            row = await cur.fetchone()
        return row["value"] if row else None

    async def get_all_settings(self) -> Dict[str, str]:
        """Retrieve all global settings as a dictionary."""
        async with self._db.execute("SELECT key, value FROM settings") as cur:
            rows = await cur.fetchall()
        return {row["key"]: row["value"] for row in rows}

    async def set_setting(self, key: str, value: str) -> None:
        await self._db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, value),
        )
        await self._db.commit()

    # ------------------------------------------------------------------
    # Dens CRUD
    # ------------------------------------------------------------------

    async def get_dens(self) -> List[Dict[str, Any]]:
        async with self._db.execute("SELECT * FROM dens ORDER BY created_at ASC") as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def get_den(self, den_id: str) -> Optional[Dict[str, Any]]:
        async with self._db.execute("SELECT * FROM dens WHERE id = ?", (den_id,)) as cur:
            row = await cur.fetchone()
        return dict(row) if row else None

    async def create_or_update_den(
        self,
        den_id: str,
        name: str,
        type_: str,
        max_runners: int,
        aws_access_key: Optional[str] = "",
        aws_secret_key: Optional[str] = "",
        aws_region: Optional[str] = "eu-west-1",
        runner_image: Optional[str] = "",
        warm_runners: int = 0,
        kill_if_unreachable: int = 1,
    ) -> None:
        now = datetime.utcnow().isoformat()
        await self._db.execute(
            """
            INSERT INTO dens (id, name, type, max_runners, aws_access_key, aws_secret_key, aws_region, runner_image, warm_runners, kill_if_unreachable, created_at)
            VALUES (:id, :name, :type, :max_runners, :aws_access_key, :aws_secret_key, :aws_region, :runner_image, :warm_runners, :kill_if_unreachable, :created_at)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                type = excluded.type,
                max_runners = excluded.max_runners,
                aws_access_key = excluded.aws_access_key,
                aws_secret_key = CASE WHEN excluded.aws_secret_key != '' AND excluded.aws_secret_key NOT LIKE '%•••%' THEN excluded.aws_secret_key ELSE dens.aws_secret_key END,
                aws_region = excluded.aws_region,
                runner_image = excluded.runner_image,
                warm_runners = excluded.warm_runners,
                kill_if_unreachable = excluded.kill_if_unreachable
            """,
            {
                "id": den_id,
                "name": name,
                "type": type_,
                "max_runners": max_runners,
                "aws_access_key": aws_access_key or "",
                "aws_secret_key": aws_secret_key or "",
                "aws_region": aws_region or "eu-west-1",
                "runner_image": runner_image or "",
                "warm_runners": warm_runners,
                "kill_if_unreachable": kill_if_unreachable,
                "created_at": now,
            },
        )
        await self._db.commit()

    async def delete_den(self, den_id: str) -> bool:
        if den_id == "local":
            return False  # Do not allow deleting the built-in Local Den
        async with self._db.execute("DELETE FROM dens WHERE id = ?", (den_id,)) as cur:
            changed = cur.rowcount
        await self._db.commit()
        return changed > 0

    # ------------------------------------------------------------------
    # Gnaw Tabs CRUD (project-scoped)
    # ------------------------------------------------------------------

    async def list_gnaw_tabs(self, project_id: str = "temp") -> list:
        async with self._db.execute(
            """
            SELECT
                id, project_id, label, position, created_at, updated_at,
                raw_request,
                JSON_EXTRACT(response, '$.status_code')   AS status_code,
                JSON_EXTRACT(response, '$.response_time') AS response_time
            FROM gnaw_tabs
            WHERE project_id = ?
            ORDER BY position ASC, created_at ASC
            """,
            (project_id,),
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def create_gnaw_tab(
        self,
        tab_id: str,
        label: str,
        raw_request: str | None,
        project_id: str = "temp",
    ) -> dict:
        now = datetime.utcnow().isoformat()
        # position = max existing + 1
        async with self._db.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM gnaw_tabs WHERE project_id = ?",
            (project_id,),
        ) as cur:
            row = await cur.fetchone()
        position = row[0] if row else 0
        await self._db.execute(
            """
            INSERT INTO gnaw_tabs (id, project_id, label, position, raw_request, response, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
            """,
            (tab_id, project_id, label, position, raw_request, now, now),
        )
        await self._db.commit()
        return {
            "id": tab_id,
            "project_id": project_id,
            "label": label,
            "position": position,
            "raw_request": raw_request,
            "response": None,
            "created_at": now,
            "updated_at": now,
        }

    async def get_gnaw_tab(self, tab_id: str, project_id: str = "temp") -> dict | None:
        async with self._db.execute(
            "SELECT * FROM gnaw_tabs WHERE id = ? AND project_id = ?",
            (tab_id, project_id),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return None
        result = dict(row)
        # Deserialize the response JSON string back to a dict
        if result.get("response") and isinstance(result["response"], str):
            try:
                result["response"] = json.loads(result["response"])
            except Exception:
                result["response"] = None
        return result

    async def update_gnaw_tab(
        self,
        tab_id: str,
        label: str,
        raw_request: str | None,
        project_id: str = "temp",
    ) -> bool:
        now = datetime.utcnow().isoformat()
        async with self._db.execute(
            "UPDATE gnaw_tabs SET label = ?, raw_request = ?, updated_at = ? "
            "WHERE id = ? AND project_id = ?",
            (label, raw_request, now, tab_id, project_id),
        ) as cur:
            changed = cur.rowcount
        await self._db.commit()
        return changed > 0

    async def delete_gnaw_tab(self, tab_id: str, project_id: str = "temp") -> bool:
        async with self._db.execute(
            "DELETE FROM gnaw_tabs WHERE id = ? AND project_id = ?",
            (tab_id, project_id),
        ) as cur:
            changed = cur.rowcount
        await self._db.commit()
        return changed > 0

    async def save_gnaw_tab_response(
        self,
        tab_id: str,
        response: dict,
        project_id: str = "temp",
    ) -> bool:
        now = datetime.utcnow().isoformat()
        async with self._db.execute(
            "UPDATE gnaw_tabs SET response = ?, updated_at = ? "
            "WHERE id = ? AND project_id = ?",
            (json.dumps(response), now, tab_id, project_id),
        ) as cur:
            changed = cur.rowcount
        await self._db.commit()
        return changed > 0


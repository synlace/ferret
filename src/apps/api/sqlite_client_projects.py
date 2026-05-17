"""
SQLiteClient mixin — Projects, Findings, Chat Sessions, Test Runs,
Project API Keys, Spend Snapshots, and Settings.

Imported by SQLiteClient via multiple inheritance:
    class SQLiteClient(ProjectsMixin):
        ...
"""

import json
import uuid
import aiosqlite
from datetime import datetime
from typing import List, Dict, Any, Optional

from models import Finding, ChatSession, TestRun, Project, ProjectApiKey


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
        await self._db.execute(
            """
            INSERT INTO chat_sessions
                (id, name, scope, scope_data, workspace_dir, target_url, plan_id, hunt_status, created_at, project_id)
            VALUES
                (:id, :name, :scope, :scope_data, :workspace_dir, :target_url, :plan_id, :hunt_status, :created_at, :project_id)
            """,
            {
                "id": session.id,
                "name": session.name,
                "scope": session.scope,
                "scope_data": _json.dumps(session.scope_data) if session.scope_data else None,
                "workspace_dir": session.workspace_dir,
                "target_url": getattr(session, "target_url", "") or "",
                "plan_id": getattr(session, "plan_id", "") or "",
                "hunt_status": getattr(session, "hunt_status", "idle") or "idle",
                "created_at": session.created_at.isoformat(),
                "project_id": session.project_id,
            },
        )
        await self._db.commit()

    async def get_chat_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Return a single chat session by ID, or None if not found."""
        async with self._db.execute(
            "SELECT * FROM chat_sessions WHERE id = ?", (session_id,)
        ) as cur:
            row = await cur.fetchone()
        return dict(row) if row else None

    async def get_chat_sessions(self, project_id: str = "temp") -> List[Dict[str, Any]]:
        async with self._db.execute(
            "SELECT * FROM chat_sessions WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,),
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def update_chat_session(self, session_id: str, updates: dict) -> bool:
        """Apply a partial update to a chat session. Allowed keys: name, scope, scope_data."""
        import json as _json
        allowed = {"name", "scope", "scope_data"}
        filtered = {k: v for k, v in updates.items() if k in allowed}
        if not filtered:
            return False
        # scope_data must be JSON-serialised
        if "scope_data" in filtered:
            filtered["scope_data"] = _json.dumps(filtered["scope_data"]) if filtered["scope_data"] else None
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
            default_model=(temp or {}).get("default_model", "google/gemini-flash-1.5"),
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

    async def set_setting(self, key: str, value: str) -> None:
        await self._db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, value),
        )
        await self._db.commit()

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

    # ------------------------------------------------------------------
    # Plans CRUD
    # ------------------------------------------------------------------

    async def get_plans(self, project_id: str) -> List[Dict[str, Any]]:
        """Return built-in plans (project_id IS NULL) UNION project plans (project_id = ?),
        ordered by is_builtin DESC, name ASC."""
        async with self._db.execute(
            """
            SELECT * FROM plans
            WHERE project_id IS NULL OR project_id = ?
            ORDER BY is_builtin DESC, name ASC
            """,
            (project_id,),
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def get_plan(self, plan_id: str) -> Optional[Dict[str, Any]]:
        """Return a single plan by ID, or None if not found."""
        async with self._db.execute(
            "SELECT * FROM plans WHERE id = ?", (plan_id,)
        ) as cur:
            row = await cur.fetchone()
        return dict(row) if row else None

    async def create_plan(self, plan: dict) -> dict:
        """Insert a plan row and return it."""
        await self._db.execute(
            """
            INSERT INTO plans
                (id, project_id, name, description, tool, prompt, max_tool_calls, is_builtin, created_at)
            VALUES
                (:id, :project_id, :name, :description, :tool, :prompt, :max_tool_calls, :is_builtin, :created_at)
            """,
            {
                "id": plan["id"],
                "project_id": plan.get("project_id"),
                "name": plan["name"],
                "description": plan.get("description", ""),
                "tool": plan.get("tool", "hunt"),
                "prompt": plan["prompt"],
                "max_tool_calls": plan.get("max_tool_calls", 15),
                "is_builtin": int(plan.get("is_builtin", 0)),
                "created_at": plan["created_at"],
            },
        )
        await self._db.commit()
        return await self.get_plan(plan["id"])

    async def update_plan(self, plan_id: str, updates: dict) -> Optional[Dict[str, Any]]:
        """Update name/description/tool/prompt/max_tool_calls only. Returns updated row or None."""
        allowed = {"name", "description", "tool", "prompt", "max_tool_calls"}
        filtered = {k: v for k, v in updates.items() if k in allowed}
        if not filtered:
            return await self.get_plan(plan_id)
        set_clause = ", ".join(f"{k} = :{k}" for k in filtered)
        filtered["plan_id"] = plan_id
        async with self._db.execute(
            f"UPDATE plans SET {set_clause} WHERE id = :plan_id",
            filtered,
        ) as cur:
            changed = cur.rowcount
        await self._db.commit()
        if changed == 0:
            return None
        return await self.get_plan(plan_id)

    async def delete_plan(self, plan_id: str, project_id: str) -> bool:
        """Delete a plan only if project_id matches and is_builtin=0. Returns True if deleted."""
        async with self._db.execute(
            "DELETE FROM plans WHERE id = ? AND project_id = ? AND is_builtin = 0",
            (plan_id, project_id),
        ) as cur:
            changed = cur.rowcount
        await self._db.commit()
        return changed > 0

    async def clone_plan(self, plan_id: str, project_id: str) -> Optional[Dict[str, Any]]:
        """Copy a built-in plan into the project with a new UUID. Returns the new plan or None."""
        source = await self.get_plan(plan_id)
        if not source:
            return None
        new_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        new_plan = {
            "id": new_id,
            "project_id": project_id,
            "name": source["name"],
            "description": source.get("description", ""),
            "tool": source.get("tool", "hunt"),
            "prompt": source["prompt"],
            "max_tool_calls": source.get("max_tool_calls", 15),
            "is_builtin": 0,
            "created_at": now,
        }
        return await self.create_plan(new_plan)

    async def _seed_builtin_plans(self) -> None:
        """Insert built-in plans if they don't already exist (checked by name WHERE project_id IS NULL)."""
        BUILTIN_PLANS = [
            {
                "name": "Quick Recon",
                "description": "Crawl the target, check security headers, summarise findings.",
                "tool": "hunt",
                "prompt": (
                    "Run a quick recon against {{target}}.\n"
                    "1. Crawl with katana (depth 3, js_crawl true) to discover endpoints.\n"
                    "2. Send a GET request to the root path and inspect the response headers for security misconfigurations (missing CSP, HSTS, X-Frame-Options, etc.).\n"
                    "3. List all discovered endpoints.\n"
                    "4. Write a concise summary to notes/recon.md covering: target, endpoints found, header issues, and any interesting observations."
                ),
                "max_tool_calls": 15,
            },
            {
                "name": "Full Recon",
                "description": "Deep crawl + ffuf directory fuzzing + JS endpoint extraction.",
                "tool": "hunt",
                "prompt": (
                    "Run a full recon against {{target}}.\n"
                    "1. Crawl with katana (depth 5, js_crawl true, headless false).\n"
                    "2. Run ffuf on the root path with the raft-medium-directories wordlist to find hidden directories.\n"
                    "3. Use run_script (python3) to extract any API endpoints from discovered JavaScript files.\n"
                    "4. Check security headers on the root path.\n"
                    "5. Write a detailed report to notes/recon.md covering all findings."
                ),
                "max_tool_calls": 30,
            },
            {
                "name": "API Surface",
                "description": "Enumerate REST endpoints, probe authentication behaviour.",
                "tool": "hunt",
                "prompt": (
                    "Map the API surface of {{target}}.\n"
                    "1. Crawl with katana focusing on API paths (/api/, /v1/, /v2/, /graphql, /rest/).\n"
                    "2. Run ffuf with the api-endpoints wordlist against common API base paths.\n"
                    "3. For each discovered endpoint, probe with GET and OPTIONS to determine auth requirements (200 vs 401 vs 403).\n"
                    "4. Note any endpoints that return data without authentication.\n"
                    "5. Write findings to notes/api-surface.md."
                ),
                "max_tool_calls": 25,
            },
            {
                "name": "Subdomain Enum",
                "description": "Discover subdomains via DNS fuzzing, probe each live host.",
                "tool": "hunt",
                "prompt": (
                    "Enumerate subdomains for {{target}}.\n"
                    "1. Extract the base domain from {{target}}.\n"
                    "2. Run ffuf with the subdomains-top1million-5000 wordlist against the base domain using DNS mode.\n"
                    "3. For each discovered subdomain, send a GET request to check if it is live.\n"
                    "4. Note the status code, server header, and title of each live subdomain.\n"
                    "5. Write results to notes/subdomains.md."
                ),
                "max_tool_calls": 20,
            },
        ]
        now = datetime.utcnow().isoformat()
        for plan in BUILTIN_PLANS:
            # Check if a built-in with this name already exists
            async with self._db.execute(
                "SELECT id FROM plans WHERE name = ? AND project_id IS NULL",
                (plan["name"],),
            ) as cur:
                existing = await cur.fetchone()
            if existing:
                continue
            await self._db.execute(
                """
                INSERT INTO plans
                    (id, project_id, name, description, tool, prompt, max_tool_calls, is_builtin, created_at)
                VALUES
                    (?, NULL, ?, ?, ?, ?, ?, 1, ?)
                """,
                (
                    str(uuid.uuid4()),
                    plan["name"],
                    plan["description"],
                    plan["tool"],
                    plan["prompt"],
                    plan["max_tool_calls"],
                    now,
                ),
            )
        await self._db.commit()

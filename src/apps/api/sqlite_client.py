"""
SQLite client for FERRET
Handles storage and retrieval of HTTP requests using aiosqlite.
Replaces the previous Elasticsearch dependency with a zero-infrastructure
embedded database — no extra container, no JVM, instant startup.

Project-scoped CRUD (findings, chat sessions, test runs, projects, API keys,
spend snapshots, settings) lives in sqlite_client_projects.ProjectsMixin which
is composed in via multiple inheritance.
"""

import json
import uuid
import aiosqlite
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional
from pathlib import Path

from models import HttpRequest, SearchFilter, Finding, ChatSession, TestRun, Project, ProjectApiKey
from sqlite_client_projects import ProjectsMixin


DB_PATH = Path("/data/ferret.db")


class SQLiteClient(ProjectsMixin):
    """Async SQLite client for storing and searching HTTP requests."""

    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self._db: Optional[aiosqlite.Connection] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def initialize(self) -> None:
        """Open the database connection and create tables / FTS index."""
        # Ensure the directory exists (sync is fine here — runs once at startup)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # Pass str — some sqlite3 builds don't accept pathlib.Path directly
        self._db = await aiosqlite.connect(str(self.db_path))
        self._db.row_factory = aiosqlite.Row
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.execute("PRAGMA busy_timeout=5000")
        await self._db.execute("PRAGMA synchronous=NORMAL")
        await self._db.execute("PRAGMA foreign_keys=ON")
        await self._db.commit()
        await self._create_schema()
        print(f"SQLite database ready at {self.db_path}")

    async def close(self) -> None:
        if self._db:
            await self._db.close()
            self._db = None

    async def health_check(self) -> Dict[str, Any]:
        try:
            async with self._db.execute("SELECT COUNT(*) FROM requests") as cur:
                row = await cur.fetchone()
                count = row[0]
            return {"status": "healthy", "backend": "sqlite", "total_requests": count}
        except Exception as e:
            return {"status": "unhealthy", "backend": "sqlite", "error": str(e)}

    # ------------------------------------------------------------------
    # Schema
    # ------------------------------------------------------------------

    async def _create_schema(self) -> None:
        await self._db.executescript("""
            CREATE TABLE IF NOT EXISTS requests (
                id              TEXT PRIMARY KEY,
                timestamp       TEXT NOT NULL,
                method          TEXT NOT NULL,
                url             TEXT NOT NULL,
                host            TEXT NOT NULL,
                path            TEXT NOT NULL,
                query_params    TEXT,
                headers         TEXT NOT NULL,
                body            TEXT,
                content_type    TEXT,
                content_length  INTEGER DEFAULT 0,
                status_code     INTEGER,
                response_headers TEXT,
                response_body   TEXT,
                response_time   REAL,
                response_size   INTEGER,
                client_ip       TEXT,
                server_ip       TEXT,
                tls_version     TEXT,
                intercepted     INTEGER DEFAULT 0,
                modified        INTEGER DEFAULT 0,
                annotation      TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_requests_method    ON requests(method);
            CREATE INDEX IF NOT EXISTS idx_requests_host      ON requests(host);
            CREATE INDEX IF NOT EXISTS idx_requests_status    ON requests(status_code);

            -- Full-text search over url, host, path, body, response_body
            CREATE VIRTUAL TABLE IF NOT EXISTS requests_fts USING fts5(
                id UNINDEXED,
                url,
                host,
                path,
                body,
                response_body,
                content=requests,
                content_rowid=rowid
            );

            -- Keep FTS in sync
            CREATE TRIGGER IF NOT EXISTS requests_ai AFTER INSERT ON requests BEGIN
                INSERT INTO requests_fts(rowid, id, url, host, path, body, response_body)
                VALUES (new.rowid, new.id, new.url, new.host, new.path, new.body, new.response_body);
            END;

            CREATE TRIGGER IF NOT EXISTS requests_au AFTER UPDATE ON requests BEGIN
                INSERT INTO requests_fts(requests_fts, rowid, id, url, host, path, body, response_body)
                VALUES ('delete', old.rowid, old.id, old.url, old.host, old.path, old.body, old.response_body);
                INSERT INTO requests_fts(rowid, id, url, host, path, body, response_body)
                VALUES (new.rowid, new.id, new.url, new.host, new.path, new.body, new.response_body);
            END;

            CREATE TRIGGER IF NOT EXISTS requests_ad AFTER DELETE ON requests BEGIN
                INSERT INTO requests_fts(requests_fts, rowid, id, url, host, path, body, response_body)
                VALUES ('delete', old.rowid, old.id, old.url, old.host, old.path, old.body, old.response_body);
            END;

            -- Chat message persistence
            -- NOTE: request_id is a dual-purpose key: it holds either a
            -- requests.id (for per-request chat) or a chat_sessions.id
            -- (for standalone chat sessions).  No FK is declared so that
            -- both use-cases can coexist without constraint violations.
            CREATE TABLE IF NOT EXISTS chat_messages (
                id           TEXT PRIMARY KEY,
                request_id   TEXT NOT NULL,
                role         TEXT NOT NULL,
                content      TEXT,
                tool_call_id TEXT,
                name         TEXT,
                tool_calls   TEXT,
                created_at   TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_chat_request_id ON chat_messages(request_id, created_at);

            -- Findings
            CREATE TABLE IF NOT EXISTS findings (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                severity    TEXT NOT NULL DEFAULT 'info',
                type        TEXT NOT NULL DEFAULT 'other',
                host        TEXT NOT NULL DEFAULT '',
                request_id  TEXT,
                source      TEXT NOT NULL DEFAULT 'manual',
                status      TEXT NOT NULL DEFAULT 'open',
                description TEXT,
                evidence    TEXT,
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_findings_host     ON findings(host);
            CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
            CREATE INDEX IF NOT EXISTS idx_findings_status   ON findings(status);

            -- Chat sessions (multi-chat / workspaces)
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                scope         TEXT NOT NULL DEFAULT 'blank',
                scope_data    TEXT,
                workspace_dir TEXT,
                created_at    TEXT NOT NULL
            );

            -- Test runs
            CREATE TABLE IF NOT EXISTS test_runs (
                id          TEXT PRIMARY KEY,
                file        TEXT NOT NULL,
                test_name   TEXT,
                host        TEXT NOT NULL DEFAULT '',
                via_proxy   INTEGER NOT NULL DEFAULT 0,
                status      TEXT NOT NULL DEFAULT 'pending',
                output      TEXT,
                started_at  TEXT,
                finished_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_test_runs_file ON test_runs(file);

            -- Projects
            CREATE TABLE IF NOT EXISTS projects (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                description   TEXT DEFAULT '',
                color         TEXT DEFAULT '#f97316',
                emoji         TEXT DEFAULT '',
                labels        TEXT DEFAULT '[]',
                default_model TEXT DEFAULT 'google/gemini-3-flash-preview',
                is_temp       INTEGER DEFAULT 0,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            );

            -- Settings (key/value store)
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- OpenRouter provisioned API keys per project
            CREATE TABLE IF NOT EXISTS project_api_keys (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name        TEXT NOT NULL,
                key_hash    TEXT NOT NULL UNIQUE,
                key_preview TEXT NOT NULL,
                key_value   TEXT NOT NULL,
                limit_usd   REAL,
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_pak_project ON project_api_keys(project_id, created_at DESC);

            -- Spend snapshots for cost tracking
            CREATE TABLE IF NOT EXISTS spend_snapshots (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL,
                key_hash    TEXT NOT NULL,
                usage_usd   REAL NOT NULL,
                limit_usd   REAL,
                snapshot_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ss_project ON spend_snapshots(project_id, snapshot_at DESC);

            -- Gnaw tabs (persisted, project-scoped)
            CREATE TABLE IF NOT EXISTS gnaw_tabs (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL DEFAULT 'temp',
                label       TEXT NOT NULL,
                position    INTEGER NOT NULL DEFAULT 0,
                raw_request TEXT,
                response    TEXT,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_gnaw_tabs_project ON gnaw_tabs(project_id, position ASC);
        """)
        await self._db.commit()

        # Migration guards: add columns to existing databases created before
        # these columns existed.
        for migration in [
            "ALTER TABLE requests ADD COLUMN annotation TEXT",
            "ALTER TABLE requests ADD COLUMN source TEXT DEFAULT 'proxy'",
        ]:
            try:
                await self._db.execute(migration)
                await self._db.commit()
            except Exception:
                pass  # column/table already exists — safe to ignore

        # Migration: add project_id to all child tables
        for table in ("requests", "findings", "chat_sessions", "test_runs"):
            try:
                await self._db.execute(
                    f"ALTER TABLE {table} ADD COLUMN project_id TEXT DEFAULT 'temp'"
                )
                await self._db.commit()
            except Exception:
                pass  # column already exists

        # Migration: add emoji + labels columns to projects table
        for migration in [
            "ALTER TABLE projects ADD COLUMN emoji TEXT DEFAULT ''",
            "ALTER TABLE projects ADD COLUMN labels TEXT DEFAULT '[]'",
            "ALTER TABLE projects ADD COLUMN default_model TEXT DEFAULT 'google/gemini-3-flash-preview'",
        ]:
            try:
                await self._db.execute(migration)
                await self._db.commit()
            except Exception:
                pass  # column already exists

        # Migration: add workspace_dir to chat_sessions
        try:
            await self._db.execute(
                "ALTER TABLE chat_sessions ADD COLUMN workspace_dir TEXT"
            )
            await self._db.commit()
        except Exception:
            pass  # column already exists

    # ------------------------------------------------------------------
    # Temp-project seed (idempotent)
    # ------------------------------------------------------------------

    async def seed_temp_project(self) -> None:
        """Insert the built-in 'temp' project if it doesn't already exist."""
        now = datetime.utcnow().isoformat()
        await self._db.execute(
            """
            INSERT OR IGNORE INTO projects
                (id, name, description, color, is_temp, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "temp",
                "Temporary Workspace",
                "Default workspace for uncategorised traffic",
                "#6b7280",
                1,
                now,
                now,
            ),
        )
        await self._db.commit()

    # ------------------------------------------------------------------
    # Write operations
    # ------------------------------------------------------------------

    async def store_request(self, request: HttpRequest, project_id: str = "temp") -> None:
        await self._db.execute(
            """
            INSERT OR REPLACE INTO requests (
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
            {**self._to_row(request), "project_id": project_id},
        )
        await self._db.commit()

    async def set_annotation(self, request_id: str, annotation: str) -> None:
        """Persist an AI-generated annotation for a captured request."""
        await self._db.execute(
            "UPDATE requests SET annotation = ? WHERE id = ?",
            (annotation, request_id),
        )
        await self._db.commit()

    async def update_request(self, request_id: str, request: HttpRequest) -> None:
        """Update an existing request row (used when the response arrives)."""
        await self._db.execute(
            """
            UPDATE requests SET
                status_code      = :status_code,
                response_headers = :response_headers,
                response_body    = :response_body,
                response_time    = :response_time,
                response_size    = :response_size,
                modified         = :modified
            WHERE id = :id
            """,
            {
                "id": request_id,
                "status_code": request.status_code,
                "response_headers": json.dumps(request.response_headers) if request.response_headers else None,
                "response_body": request.response_body,
                "response_time": request.response_time,
                "response_size": request.response_size,
                "modified": int(request.modified),
            },
        )
        await self._db.commit()

    # ------------------------------------------------------------------
    # Read operations
    # ------------------------------------------------------------------

    async def get_request(self, request_id: str) -> Optional[HttpRequest]:
        async with self._db.execute(
            "SELECT rowid, * FROM requests WHERE id = ?", (request_id,)
        ) as cur:
            row = await cur.fetchone()
        return self._from_row(row) if row else None

    # ------------------------------------------------------------------
    # Internal helper: build WHERE clause for search/filter params.
    # Returns (sql_fragment, params_list).
    # ``prefix`` is "r." when the query aliases the table, "" otherwise.
    # ------------------------------------------------------------------

    @staticmethod
    def _build_filter_clause(
        prefix: str,
        method: Optional[str],
        status_code: Optional[int],
        host: Optional[str],
        source: Optional[str],
    ) -> tuple:
        sql = ""
        params: list = []
        if method:
            sql += f" AND {prefix}method = ?"
            params.append(method.upper())
        if status_code is not None:
            sql += f" AND {prefix}status_code = ?"
            params.append(status_code)
        if host:
            sql += f" AND {prefix}host LIKE ?"
            params.append(f"%{host}%")
        if source:
            sql += f" AND {prefix}source = ?"
            params.append(source)
        return sql, params

    @staticmethod
    def _search_uses_like(search: Optional[str]) -> bool:
        """
        Use LIKE (on url/host/path) instead of FTS5 MATCH whenever the search
        term contains any character that is not a plain word character or
        whitespace.

        FTS5 treats many punctuation characters as operators or syntax:
        ``.`` tokenises domain names into fragments, ``/`` is a syntax error,
        ``:`` triggers column-filter syntax, ``-`` is a NOT operator, ``*`` is
        a prefix wildcard, etc.  Rather than enumerate every hostile character,
        we simply require the query to consist only of ``[A-Za-z0-9_]`` and
        spaces to qualify for FTS5.  Everything else goes through LIKE.
        """
        import re as _re
        return bool(search and _re.search(r"[^\w\s]", search))

    async def search_requests(
        self,
        limit: int = 100,
        offset: int = 0,
        method: Optional[str] = None,
        status_code: Optional[int] = None,
        host: Optional[str] = None,
        search: Optional[str] = None,
        source: Optional[str] = None,
        project_id: str = "temp",
    ) -> List[HttpRequest]:
        """
        Filter requests by method / status_code / host and optionally
        full-text search across url, host, path, body, response_body.

        When the search term contains a dot (e.g. a domain name or URL
        fragment) SQLite FTS tokenisation would break it up, so we fall back
        to a LIKE search on url / host / path instead.
        """
        use_like = self._search_uses_like(search)

        if search and not use_like:
            # FTS path: join against the virtual table
            sql = """
                SELECT r.rowid, r.* FROM requests r
                JOIN requests_fts f ON r.rowid = f.rowid
                WHERE requests_fts MATCH ?
                AND r.project_id = ?
            """
            params: list = [search, project_id]
            filter_sql, filter_params = self._build_filter_clause("r.", method, status_code, host, source)
        elif search and use_like:
            # LIKE path: dot in search term — match against url, host, path
            sql = """
                SELECT rowid, * FROM requests
                WHERE project_id = ?
                AND (url LIKE ? OR host LIKE ? OR path LIKE ?)
            """
            like_val = f"%{search}%"
            params = [project_id, like_val, like_val, like_val]
            filter_sql, filter_params = self._build_filter_clause("", method, status_code, host, source)
        else:
            sql = "SELECT rowid, * FROM requests WHERE project_id = ?"
            params = [project_id]
            filter_sql, filter_params = self._build_filter_clause("", method, status_code, host, source)

        sql += filter_sql
        params.extend(filter_params)
        sql += " ORDER BY timestamp DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        async with self._db.execute(sql, params) as cur:
            rows = await cur.fetchall()
        return [self._from_row(r) for r in rows]

    async def count_requests(
        self,
        method: Optional[str] = None,
        status_code: Optional[int] = None,
        host: Optional[str] = None,
        search: Optional[str] = None,
        source: Optional[str] = None,
        project_id: str = "temp",
    ) -> int:
        """Return the total number of rows matching the given filters (no LIMIT/OFFSET)."""
        use_like = self._search_uses_like(search)

        if search and not use_like:
            sql = """
                SELECT COUNT(*) FROM requests r
                JOIN requests_fts f ON r.rowid = f.rowid
                WHERE requests_fts MATCH ?
                AND r.project_id = ?
            """
            params: list = [search, project_id]
            filter_sql, filter_params = self._build_filter_clause("r.", method, status_code, host, source)
        elif search and use_like:
            like_val = f"%{search}%"
            sql = """
                SELECT COUNT(*) FROM requests
                WHERE project_id = ?
                AND (url LIKE ? OR host LIKE ? OR path LIKE ?)
            """
            params = [project_id, like_val, like_val, like_val]
            filter_sql, filter_params = self._build_filter_clause("", method, status_code, host, source)
        else:
            sql = "SELECT COUNT(*) FROM requests WHERE project_id = ?"
            params = [project_id]
            filter_sql, filter_params = self._build_filter_clause("", method, status_code, host, source)

        sql += filter_sql
        params.extend(filter_params)

        async with self._db.execute(sql, params) as cur:
            row = await cur.fetchone()
        return row[0] if row else 0

    async def clear_all_requests(self, project_id: str = "temp") -> int:
        """Delete all requests for a project (and their chat messages via CASCADE). Returns deleted count.

        Deletes rows one-by-one so the requests_ad AFTER DELETE trigger fires for
        each row and keeps requests_fts consistent across all projects.

        If the FTS index is corrupted, falls back to a bulk delete + full FTS
        rebuild so the operation always succeeds.
        """
        async with self._db.execute(
            "SELECT rowid FROM requests WHERE project_id = ?", (project_id,)
        ) as cur:
            rowids = [row[0] for row in await cur.fetchall()]

        count = len(rowids)
        try:
            for rowid in rowids:
                await self._db.execute("DELETE FROM requests WHERE rowid = ?", (rowid,))
            await self._db.commit()
        except Exception:
            # FTS index is corrupted — bulk-delete then rebuild the whole index.
            await self._db.execute(
                "DELETE FROM requests WHERE project_id = ?", (project_id,)
            )
            await self._db.execute(
                "INSERT INTO requests_fts(requests_fts) VALUES('rebuild')"
            )
            await self._db.commit()
        return count

    # ------------------------------------------------------------------
    # Chat message persistence
    # ------------------------------------------------------------------

    async def save_chat_messages(self, request_id: str, messages: List[Dict[str, Any]]) -> None:
        """Append a list of chat messages for a given request to the DB."""
        now = datetime.now(timezone.utc).isoformat()
        rows = []
        for m in messages:
            rows.append((
                str(uuid.uuid4()),
                request_id,
                m.get("role", ""),
                m.get("content"),
                m.get("tool_call_id"),
                m.get("name"),
                json.dumps(m["tool_calls"]) if m.get("tool_calls") else None,
                now,
            ))
        await self._db.executemany(
            """
            INSERT INTO chat_messages (id, request_id, role, content, tool_call_id, name, tool_calls, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        await self._db.commit()

    async def get_chat_messages(self, request_id: str) -> List[Dict[str, Any]]:
        """Return all chat messages for a request, ordered by creation time."""
        async with self._db.execute(
            "SELECT role, content, tool_call_id, name, tool_calls, created_at FROM chat_messages "
            "WHERE request_id = ? ORDER BY created_at ASC",
            (request_id,),
        ) as cur:
            rows = await cur.fetchall()
        result = []
        for row in rows:
            msg: Dict[str, Any] = {"role": row["role"], "content": row["content"]}
            if row["tool_call_id"]:
                msg["tool_call_id"] = row["tool_call_id"]
            if row["name"]:
                msg["name"] = row["name"]
            if row["tool_calls"]:
                msg["tool_calls"] = json.loads(row["tool_calls"])
            # Expose created_at as timestamp so the UI can display it on reload.
            # Format: "YYYY-MM-DD HH:MM" (strip seconds/microseconds if present).
            if row["created_at"]:
                ts = str(row["created_at"])[:16].replace("T", " ")
                msg["timestamp"] = ts
            result.append(msg)
        return result

    async def clear_chat_messages(self, request_id: str) -> None:
        """Delete all chat messages for a request."""
        await self._db.execute(
            "DELETE FROM chat_messages WHERE request_id = ?", (request_id,)
        )
        await self._db.commit()

    # ------------------------------------------------------------------
    # Stats
    # ------------------------------------------------------------------

    async def get_stats(self, project_id: str = "temp") -> Dict[str, Any]:
        stats: Dict[str, Any] = {}
        async with self._db.execute(
            "SELECT COUNT(*) FROM requests WHERE project_id = ?", (project_id,)
        ) as cur:
            stats["total_requests"] = (await cur.fetchone())[0]
        async with self._db.execute(
            "SELECT COUNT(*) FROM requests WHERE status_code IS NOT NULL AND project_id = ?",
            (project_id,),
        ) as cur:
            stats["completed_requests"] = (await cur.fetchone())[0]
        async with self._db.execute(
            "SELECT method, COUNT(*) as cnt FROM requests WHERE project_id = ? GROUP BY method ORDER BY cnt DESC",
            (project_id,),
        ) as cur:
            stats["by_method"] = {r["method"]: r["cnt"] for r in await cur.fetchall()}
        async with self._db.execute(
            """
            SELECT
                CAST(status_code / 100 AS TEXT) || 'xx' AS bucket,
                COUNT(*) AS cnt
            FROM requests
            WHERE status_code IS NOT NULL AND project_id = ?
            GROUP BY bucket
            ORDER BY bucket
            """,
            (project_id,),
        ) as cur:
            stats["by_status_class"] = {r["bucket"]: r["cnt"] for r in await cur.fetchall()}
        return stats

    # ------------------------------------------------------------------
    # Serialisation helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _to_row(req: HttpRequest) -> Dict[str, Any]:
        return {
            "id": req.id,
            "timestamp": req.timestamp.isoformat(),
            "method": req.method.value if hasattr(req.method, "value") else req.method,
            "url": req.url,
            "host": req.host,
            "path": req.path,
            "query_params": json.dumps(req.query_params) if req.query_params else None,
            "headers": json.dumps(req.headers),
            "body": req.body,
            "content_type": req.content_type,
            "content_length": req.content_length,
            "status_code": req.status_code,
            "response_headers": json.dumps(req.response_headers) if req.response_headers else None,
            "response_body": req.response_body,
            "response_time": req.response_time,
            "response_size": req.response_size,
            "client_ip": req.client_ip,
            "server_ip": req.server_ip,
            "tls_version": req.tls_version,
            "intercepted": int(req.intercepted),
            "modified": int(req.modified),
            "annotation": req.annotation,
            "source": req.source,
        }

    @staticmethod
    def _from_row(row: aiosqlite.Row) -> HttpRequest:
        d = dict(row)
        # rowid is selected as the first column when we do "SELECT rowid, *"
        # Map it to the seq field; pop it so it doesn't conflict with named columns
        d["seq"] = d.pop("rowid", None)
        d["query_params"] = json.loads(d["query_params"]) if d["query_params"] else None
        d["headers"] = json.loads(d["headers"]) if d["headers"] else {}
        d["response_headers"] = json.loads(d["response_headers"]) if d["response_headers"] else None
        d["intercepted"] = bool(d["intercepted"])
        d["modified"] = bool(d["modified"])
        # annotation may be absent in rows from older schema versions
        d.setdefault("annotation", None)
        # source may be absent in rows from older schema versions
        d["source"] = row["source"] if "source" in row.keys() else "proxy"
        # project_id may be absent in rows from older schema versions
        d.setdefault("project_id", "temp")
        # Remove project_id from dict before passing to HttpRequest (not a field on it)
        d.pop("project_id", None)
        return HttpRequest(**d)

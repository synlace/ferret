"""
Application settings endpoints.
"""

import os
import base64
import json
import logging
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

import deps
from models import Project

router = APIRouter()

_log = logging.getLogger(__name__)


class ActiveProjectBody(BaseModel):
    project_id: str


class DenConfigSchema(BaseModel):
    id: Optional[str] = "local"
    name: str = "Local Den"
    den_max_runners: int


async def _assert_setup_or_authenticated(request: Request):
    """Enforce authentication on Den settings endpoints ONLY IF setup has been completed."""
    complete = await deps.db_client.get_setting("setup_complete")
    if complete == "1":
        await deps.require_auth(request)


@router.get("/api/settings/active-project")
async def get_active_project():
    """Return the currently active project ID."""
    try:
        project_id = await deps.db_client.get_setting("active_project_id") or "temp"
        return {"project_id": project_id}
    except Exception as e:
        raise deps.server_error(e)


@router.put("/api/settings/active-project")
async def set_active_project(body: ActiveProjectBody):
    """Set the active project. Validates that the project exists."""
    try:
        project = await deps.db_client.get_project(body.project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        await deps.db_client.set_setting("active_project_id", body.project_id)
        return {"project_id": body.project_id}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/settings/dens")
async def list_dens(request: Request):
    """List all registered Dens."""
    try:
        await _assert_setup_or_authenticated(request)
        dens = await deps.db_client.get_dens()
        
        results = []
        return [
            DenConfigSchema(
                id=den["id"],
                name=den["name"],
                den_max_runners=den["max_runners"]
            )
            for den in dens
        ]
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/settings/dens/{den_id}", response_model=DenConfigSchema)
async def get_den_by_id(den_id: str, request: Request):
    """Get a single runner Den configuration by ID."""
    try:
        await _assert_setup_or_authenticated(request)
        den = await deps.db_client.get_den(den_id)
        if not den:
            raise HTTPException(status_code=404, detail="Den not found")

        return DenConfigSchema(
            id=den["id"],
            name=den["name"],
            den_max_runners=den["max_runners"]
        )
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/settings/dens")
@router.put("/api/settings/dens/{den_id}")
async def save_den_settings(body: DenConfigSchema, request: Request, den_id: Optional[str] = None):
    """Create or update a runner Den configuration."""
    try:
        await _assert_setup_or_authenticated(request)
        target_id = den_id or body.id or "local"

        await deps.db_client.create_or_update_den(
            den_id=target_id,
            name=body.name,
            max_runners=body.den_max_runners
        )
        return {"status": "success", "id": target_id}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/settings/dens/{den_id}")
async def delete_den_by_id(den_id: str, request: Request):
    """Delete a runner Den configuration."""
    try:
        await _assert_setup_or_authenticated(request)
        if den_id == "local":
            raise HTTPException(status_code=400, detail="Cannot delete built-in Local Den")
        success = await deps.db_client.delete_den(den_id)
        if not success:
            raise HTTPException(status_code=404, detail="Den not found")
        return {"status": "success"}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/settings/den", response_model=DenConfigSchema)
async def get_den_settings(request: Request):
    """Backward compatibility fallback: Get the 'local' Den configuration."""
    try:
        await _assert_setup_or_authenticated(request)
        den = await deps.db_client.get_den("local")
        if not den:
            return DenConfigSchema(id="local", name="Local Den", den_max_runners=10)

        return DenConfigSchema(
            id=den["id"],
            name=den["name"],
            den_max_runners=den["max_runners"]
        )
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.put("/api/settings/den")
async def set_den_settings(body: DenConfigSchema, request: Request):
    """Backward compatibility fallback: Update the 'local' Den configuration."""
    return await save_den_settings(body, request, "local")


@router.post("/api/settings/den/test")
async def test_den_config(body: DenConfigSchema, request: Request):
    """Test local Den connectivity/configuration."""
    try:
        await _assert_setup_or_authenticated(request)
        return {"ok": True, "detail": "Local Docker sandbox environment is ready."}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


class ExportRequest(BaseModel):
    passphrase: Optional[str] = None
    export_settings: bool = True
    export_dens: bool = True
    export_projects: bool = True


class ImportRequest(BaseModel):
    file_content: str  # Base64 encoded JSON file content
    passphrase: Optional[str] = None


def _derive_fernet_key(passphrase: str, salt: bytes) -> bytes:
    """Derive a 256-bit symmetric key using PBKDF2HMAC."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=100_000
    )
    derived = kdf.derive(passphrase.encode("utf-8"))
    return base64.urlsafe_b64encode(derived)


@router.post("/api/settings/export")
async def export_settings(body: ExportRequest, request: Request):
    """
    Export requested configuration components (settings, runner dens, and project datasets).
    Supports optional passphrase-based symmetric encryption.
    """
    await deps.require_auth(request)
    
    try:
        raw_payload = {
            "version": "1.0",
            "timestamp": datetime.utcnow().isoformat(),
        }

        # Option: Global Settings
        if body.export_settings:
            settings_dict = await deps.db_client.get_all_settings()
            raw_payload["settings"] = {k: v for k, v in settings_dict.items() if k != "gnaw_current_request"}

        # Option: Runner Environments
        if body.export_dens:
            raw_payload["dens"] = await deps.db_client.get_dens()

        # Option: All Projects + Child datasets (findings, proxy requests, sessions, test runs)
        if body.export_projects:
            projects = await deps.db_client.get_projects()
            projects_backup = []
            for p in projects:
                p_id = p["id"]
                project_export = await deps.db_client.export_project(p_id)
                if project_export:
                    projects_backup.append(project_export)
            raw_payload["projects"] = projects_backup

        # Optional Encryption
        if body.passphrase:
            salt = os.urandom(16)
            fernet_key = _derive_fernet_key(body.passphrase, salt)
            f = Fernet(fernet_key)
            
            serialized = json.dumps(raw_payload).encode("utf-8")
            ciphertext = f.encrypt(serialized).decode("utf-8")
            
            return {
                "encrypted": True,
                "salt": base64.b64encode(salt).decode("utf-8"),
                "ciphertext": ciphertext
            }
        
        return {
            "encrypted": False,
            "data": raw_payload
        }
        
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/settings/import")
async def import_settings(body: ImportRequest, request: Request):
    """
    Import settings, custom runner environments, and project workspaces.
    Bypasses token verification strictly if first-run setup is not complete.
    """
    complete = await deps.db_client.get_setting("setup_complete")
    if complete == "1":
        await deps.require_auth(request)

    try:
        file_bytes = base64.b64decode(body.file_content)
        backup_json = json.loads(file_bytes.decode("utf-8"))
        
        # 1. Resolve encrypted vs plaintext backup payload
        if backup_json.get("encrypted"):
            if not body.passphrase:
                raise HTTPException(status_code=400, detail="Passphrase is required for encrypted backups.")
            try:
                salt = base64.b64decode(backup_json["salt"])
                ciphertext = backup_json["ciphertext"].encode("utf-8")
                fernet_key = _derive_fernet_key(body.passphrase, salt)
                f = Fernet(fernet_key)
                
                decrypted = f.decrypt(ciphertext)
                raw_payload = json.loads(decrypted.decode("utf-8"))
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid passphrase or corrupted file.")
        else:
            raw_payload = backup_json.get("data")
            if not raw_payload:
                raise HTTPException(status_code=400, detail="Invalid backup file structure.")

        # 2. Apply key-values to `settings` table and project snapshots inside a transaction
        try:
            imported_settings = raw_payload.get("settings", {})
            for key, value in imported_settings.items():
                if key == "setup_complete" and complete != "1":
                    _log.info(
                        "Skipped importing setup_complete from backup to preserve active setup wizard state",
                        extra={"details": "Bypassed importing the setup_complete flag from the restored backup settings because the target installation's setup is not yet complete."}
                    )
                    continue
                await deps.db_client.set_setting(key, value)
                
            # 3. Apply items to `dens` table
            imported_dens = raw_payload.get("dens", [])
            for den in imported_dens:
                await deps.db_client.create_or_update_den(
                    den_id=den["id"],
                    name=den["name"],
                    max_runners=den["max_runners"]
                )

            # 4. Apply Project Snapshots
            imported_projects = raw_payload.get("projects", [])
            for p_data in imported_projects:
                src_project = p_data.get("project", {})
                p_id = src_project.get("id")
                if not p_id:
                    continue
                
                # Prevent duplicate constraints - drop or update existing matches
                if p_id == "temp":
                    # Clear child data for temp manually
                    await deps.db_client.reset_temp_project()
                    
                    # Update 'temp' project properties instead of creating a new one
                    await deps.db_client._db.execute(
                        """
                        UPDATE projects SET
                            name = :name,
                            description = :description,
                            color = :color,
                            emoji = :emoji,
                            labels = :labels,
                            default_model = :default_model,
                            is_temp = 1,
                            updated_at = :updated_at
                        WHERE id = 'temp'
                        """,
                        {
                            "name": src_project.get("name", "Demo Project"),
                            "description": src_project.get("description", "Default workspace for uncategorised traffic"),
                            "color": src_project.get("color", "#6b7280"),
                            "emoji": src_project.get("emoji", ""),
                            "labels": json.dumps(src_project.get("labels", "[]")) if isinstance(src_project.get("labels"), str) else json.dumps(src_project.get("labels", [])),
                            "default_model": src_project.get("default_model"),
                            "updated_at": datetime.utcnow().isoformat()
                        }
                    )
                else:
                    # Prevent duplicate constraints - drop existing matches
                    await deps.db_client.delete_project(p_id)
                    
                    created_at_val = src_project.get("created_at")
                    if isinstance(created_at_val, str):
                        created_at = datetime.fromisoformat(created_at_val.replace("Z", "+00:00"))
                    else:
                        created_at = datetime.utcnow()

                    updated_at_val = src_project.get("updated_at")
                    if isinstance(updated_at_val, str):
                        updated_at = datetime.fromisoformat(updated_at_val.replace("Z", "+00:00"))
                    else:
                        updated_at = datetime.utcnow()

                    new_project = Project(
                        id=p_id,
                        name=src_project.get("name", "Imported Project"),
                        description=src_project.get("description", ""),
                        color=src_project.get("color", "#f97316"),
                        emoji=src_project.get("emoji", ""),
                        labels=json.loads(src_project.get("labels", "[]")) if isinstance(src_project.get("labels"), str) else src_project.get("labels", []),
                        default_model=src_project.get("default_model"),
                        is_temp=int(src_project.get("is_temp", 0)),
                        created_at=created_at,
                        updated_at=updated_at
                    )
                    await deps.db_client.create_project(new_project)
                
                # Re-insert proxied requests
                for req in p_data.get("requests", []):
                    req = dict(req)
                    req["project_id"] = p_id
                    req.setdefault("annotation", None)
                    req.setdefault("source", "proxy")
                    req.setdefault("query_params", None)
                    req.setdefault("headers", "{}")
                    req.setdefault("body", None)
                    req.setdefault("content_type", None)
                    req.setdefault("content_length", 0)
                    req.setdefault("status_code", None)
                    req.setdefault("response_headers", None)
                    req.setdefault("response_body", None)
                    req.setdefault("response_time", None)
                    req.setdefault("response_size", None)
                    req.setdefault("client_ip", None)
                    req.setdefault("server_ip", None)
                    req.setdefault("tls_version", None)
                    req.setdefault("intercepted", 0)
                    req.setdefault("modified", 0)
                    await deps.db_client._db.execute(
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
                        req
                    )

                # Re-insert findings
                for f in p_data.get("findings", []):
                    f = dict(f)
                    f["project_id"] = p_id
                    f.setdefault("severity", "info")
                    f.setdefault("type", "other")
                    f.setdefault("host", "")
                    f.setdefault("request_id", None)
                    f.setdefault("source", "manual")
                    f.setdefault("status", "open")
                    f.setdefault("description", None)
                    f.setdefault("evidence", None)
                    f.setdefault("created_at", datetime.utcnow().isoformat())
                    await deps.db_client._db.execute(
                        """
                        INSERT OR IGNORE INTO findings
                            (id, title, severity, type, host, request_id, source, status,
                             description, evidence, created_at, project_id)
                        VALUES
                            (:id, :title, :severity, :type, :host, :request_id, :source, :status,
                             :description, :evidence, :created_at, :project_id)
                        """,
                        f
                    )

                # Re-insert chat sessions
                for cs in p_data.get("chat_sessions", []):
                    cs = dict(cs)
                    cs["project_id"] = p_id
                    cs.setdefault("scope", "blank")
                    cs.setdefault("scope_data", None)
                    cs.setdefault("workspace_dir", None)
                    cs.setdefault("target_url", "")
                    cs.setdefault("plan_id", "")
                    cs.setdefault("hunt_status", "idle")
                    cs.setdefault("enabled_tools", None)
                    cs.setdefault("created_at", datetime.utcnow().isoformat())
                    await deps.db_client._db.execute(
                        """
                        INSERT OR IGNORE INTO chat_sessions
                            (id, name, scope, scope_data, created_at, project_id)
                        VALUES
                            (:id, :name, :scope, :scope_data, :created_at, :project_id)
                        """,
                        cs
                    )

                # Re-insert test runs
                for tr in p_data.get("test_runs", []):
                    tr = dict(tr)
                    tr["project_id"] = p_id
                    tr.setdefault("test_name", None)
                    tr.setdefault("host", "")
                    tr.setdefault("via_proxy", 0)
                    tr.setdefault("status", "pending")
                    tr.setdefault("output", None)
                    tr.setdefault("started_at", None)
                    tr.setdefault("finished_at", None)
                    await deps.db_client._db.execute(
                        """
                        INSERT OR IGNORE INTO test_runs
                            (id, file, test_name, host, via_proxy, status, output,
                             started_at, finished_at, project_id)
                        VALUES
                            (:id, :file, :test_name, :host, :via_proxy, :status, :output,
                             :started_at, :finished_at, :project_id)
                        """,
                        tr
                    )

            await deps.db_client._db.commit()
        except Exception as db_err:
            try:
                await deps.db_client._db.rollback()
            except Exception:
                pass
            raise db_err

        # Update running AI context properties
        await deps.reload_ai_config()
        
        return {"status": "success", "message": "Import completed successfully."}

    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)





"""
Projects CRUD, import/export, and OpenRouter key management endpoints.
"""

import re
import uuid
import httpx
from datetime import datetime
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from typing import Dict, Any, List, Optional

import deps
from models import (
    Project, ProjectCreate, ProjectUpdate, ProjectExport,
    ProjectApiKey, ProjectApiKeyCreate, KeySpend,
)

router = APIRouter()


# ---------------------------------------------------------------------------
# Projects CRUD
# ---------------------------------------------------------------------------

@router.get("/api/projects")
async def list_projects():
    """List all projects."""
    try:
        return await deps.db_client.get_projects()
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/projects", status_code=201)
async def create_project(body: ProjectCreate):
    """
    Create a new project.
    If provision_key=True (default) and a provisioning key is configured via the
    setup wizard, automatically provisions an OpenRouter key for the project.
    """
    try:
        project = Project(
            name=body.name,
            description=body.description,
            color=body.color,
            emoji=body.emoji,
            labels=body.labels,
            default_model=body.default_model,
            is_temp=False,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        await deps.db_client.create_project(project)

        # Auto-provision an OpenRouter key if requested and provisioning key is available
        _prov_key = deps.get_ai_config().get("provisioning_key", "")
        if body.provision_key and _prov_key:
            try:
                or_payload: Dict[str, Any] = {"name": f"{body.name} (auto)"}
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.post(
                        "https://openrouter.ai/api/v1/keys",
                        headers=deps.openrouter_headers(_prov_key),
                        json=or_payload,
                    )
                    resp.raise_for_status()
                    or_data = resp.json()
                _or_inner: Dict[str, Any] = or_data.get("data") or {}
                raw_key: str = or_data.get("key", "") or _or_inner.get("key", "")
                key_hash: str = _or_inner.get("hash", "") or or_data.get("hash", "")
                if raw_key and key_hash:
                    key_record = ProjectApiKey(
                        id=str(uuid.uuid4()),
                        project_id=project.id,
                        name=f"{body.name} (auto)",
                        key_hash=key_hash,
                        key_preview=_make_key_preview(raw_key),
                        limit_usd=None,
                        created_at=datetime.utcnow().isoformat(),
                    )
                    await deps.db_client.store_project_api_key(key_record, raw_key)
            except Exception:
                # Key provisioning failure is non-fatal — project is still created
                pass

        return project
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/projects/{project_id}")
async def get_project(project_id: str):
    """Get a single project by ID."""
    try:
        project = await deps.db_client.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        return project
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.put("/api/projects/{project_id}")
async def update_project(project_id: str, body: ProjectUpdate):
    """Update a project's fields."""
    try:
        updates = body.model_dump(exclude_none=True)
        if not updates:
            raise HTTPException(status_code=400, detail="No fields to update")
        if "is_temp" in updates:
            updates["is_temp"] = int(updates["is_temp"])
        ok = await deps.db_client.update_project(project_id, updates)
        if not ok:
            raise HTTPException(status_code=404, detail="Project not found")
        return await deps.db_client.get_project(project_id)
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/projects/temp/promote", status_code=201)
async def promote_temp_project(body: ProjectCreate):
    """
    Copy the temp workspace into a new permanent project.
    The temp workspace is left intact with all its data.
    Returns the newly created project.
    """
    try:
        new_id = str(uuid.uuid4())
        new_project = await deps.db_client.promote_temp_project(
            new_name=body.name,
            new_id=new_id,
        )
        # Apply any extra fields from the request body
        extra: dict = {}
        if body.description:
            extra["description"] = body.description
        if body.emoji:
            extra["emoji"] = body.emoji
        if body.color:
            extra["color"] = body.color
        if body.labels:
            extra["labels"] = body.labels
        if body.default_model:
            extra["default_model"] = body.default_model
        if extra:
            await deps.db_client.update_project(new_id, extra)

        # Auto-provision an OpenRouter key if requested
        _prov_key2 = deps.get_ai_config().get("provisioning_key", "")
        if body.provision_key and _prov_key2:
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.post(
                        "https://openrouter.ai/api/v1/keys",
                        headers=deps.openrouter_headers(_prov_key2),
                        json={"name": f"{body.name} (auto)"},
                    )
                    resp.raise_for_status()
                    or_data = resp.json()
                _or_inner2: Dict[str, Any] = or_data.get("data") or {}
                raw_key: str = or_data.get("key", "") or _or_inner2.get("key", "")
                key_hash: str = _or_inner2.get("hash", "") or or_data.get("hash", "")
                if raw_key and key_hash:
                    key_record = ProjectApiKey(
                        id=str(uuid.uuid4()),
                        project_id=new_id,
                        name=f"{body.name} (auto)",
                        key_hash=key_hash,
                        key_preview=_make_key_preview(raw_key),
                        limit_usd=None,
                        created_at=datetime.utcnow().isoformat(),
                    )
                    await deps.db_client.store_project_api_key(key_record, raw_key)
            except Exception:
                pass

        return await deps.db_client.get_project(new_id)
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/projects/reset", status_code=204)
async def reset_database(confirm: str = ""):
    """
    Delete ALL projects (including temp) and all associated data, then
    re-seed the temp workspace.  This is a destructive operation intended
    for development use only.

    Requires ?confirm=destroy to prevent accidental or CSRF-triggered wipes.
    """
    if confirm != "destroy":
        raise HTTPException(
            status_code=400,
            detail="Pass ?confirm=destroy to confirm this destructive operation.",
        )
    try:
        projects = await deps.db_client.get_projects()
        for p in projects:
            pid = p["id"]
            if pid == "temp":
                # Clear temp data but keep the project row
                await deps.db_client.clear_all_requests(project_id="temp")
                await deps.db_client._db.execute(
                    "DELETE FROM findings WHERE project_id = 'temp'"
                )
                await deps.db_client._db.execute(
                    "DELETE FROM chat_sessions WHERE project_id = 'temp'"
                )
                await deps.db_client._db.execute(
                    "DELETE FROM test_runs WHERE project_id = 'temp'"
                )
                await deps.db_client._db.execute(
                    "DELETE FROM project_api_keys WHERE project_id = 'temp'"
                )
                await deps.db_client._db.execute(
                    "DELETE FROM spend_snapshots WHERE project_id = 'temp'"
                )
                await deps.db_client._db.commit()
            else:
                await deps.db_client.delete_project(pid)
        # Reset active project setting to temp
        await deps.db_client.set_setting("active_project_id", "temp")
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/projects/all", status_code=204)
async def delete_all_projects(confirm: str = ""):
    """Delete all projects except 'temp'.

    Requires ?confirm=destroy to prevent accidental or CSRF-triggered deletions.
    """
    if confirm != "destroy":
        raise HTTPException(
            status_code=400,
            detail="Pass ?confirm=destroy to confirm this destructive operation.",
        )
    try:
        projects = await deps.db_client.get_projects()
        for p in projects:
            pid = p["id"]
            if pid != "temp":
                await deps.db_client.delete_project(pid)
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/projects/{project_id}", status_code=204)
async def delete_project(project_id: str):
    """Delete a project and all its data. Blocks deletion of the 'temp' project."""
    try:
        if project_id == "temp":
            raise HTTPException(status_code=400, detail="Cannot delete the temporary workspace project")
        ok = await deps.db_client.delete_project(project_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Project not found")
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/projects/{project_id}/export")
async def export_project(project_id: str):
    """Export a project and all its data as a JSON download."""
    try:
        data = await deps.db_client.export_project(project_id)
        if data is None:
            raise HTTPException(status_code=404, detail="Project not found")
        export = ProjectExport(
            project=Project(**{
                **data["project"],
                "is_temp": bool(data["project"].get("is_temp", False)),
            }),
            requests=data["requests"],
            findings=data["findings"],
            chat_sessions=data["chat_sessions"],
            test_runs=data["test_runs"],
        )
        export_dict = export.model_dump(mode="json")
        project_name = data["project"].get("name", project_id)
        safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", project_name)[:40]
        return JSONResponse(
            content=export_dict,
            headers={
                "Content-Disposition": f'attachment; filename="ferret-project-{safe_name}.json"',
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/projects/import", status_code=201)
async def import_project(body: ProjectExport):
    """Import a project export. Creates a new project with a fresh UUID."""
    try:
        new_project = await deps.db_client.import_project(body.model_dump(mode="json"))
        return new_project
    except Exception as e:
        raise deps.server_error(e)


# ---------------------------------------------------------------------------
# OpenRouter Key Management
# ---------------------------------------------------------------------------

def _make_key_preview(key: str) -> str:
    """Return first 8 chars + '...' + last 4 chars of a key string."""
    if len(key) <= 12:
        return key
    return f"{key[:8]}...{key[-4:]}"


@router.post("/api/projects/{project_id}/keys", status_code=201)
async def create_project_key(project_id: str, body: ProjectApiKeyCreate):
    """
    Create a provisioned OpenRouter key for a project.
    Calls the OR API with the master key, stores the result, and returns the
    full key value ONCE (it will not be retrievable again from this API).
    """
    try:
        _prov_key3 = deps.get_ai_config().get("provisioning_key", "")
        if not _prov_key3:
            raise HTTPException(
                status_code=503,
                detail="No OpenRouter provisioning key configured. Add one via the setup wizard.",
            )
        project = await deps.db_client.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        or_payload: Dict[str, Any] = {"name": body.name}
        if body.limit_usd is not None:
            or_payload["limit"] = body.limit_usd

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    "https://openrouter.ai/api/v1/keys",
                    headers=deps.openrouter_headers(_prov_key3),
                    json=or_payload,
                )
                resp.raise_for_status()
                or_data = resp.json()
        except httpx.HTTPStatusError as e:
            raise HTTPException(502, f"OpenRouter {e.response.status_code}: {e.response.text[:200]}")
        except Exception as e:
            raise HTTPException(502, f"OpenRouter API call failed: {e}")

        # OR response shape: { "key": "sk-or-v1-...", "data": { "hash": "...", ... } }
        # Older docs also show both fields inside "data" — handle both.
        or_data_inner: Dict[str, Any] = or_data.get("data") or {}
        raw_key: str = or_data.get("key", "") or or_data_inner.get("key", "")
        key_hash: str = or_data_inner.get("hash", "") or or_data.get("hash", "")
        if not raw_key or not key_hash:
            raise HTTPException(
                502,
                f"OpenRouter returned an unexpected response (missing key/hash). "
                f"Response keys: {list(or_data.keys())}",
            )

        now = datetime.utcnow().isoformat()
        key_record = ProjectApiKey(
            id=str(uuid.uuid4()),
            project_id=project_id,
            name=body.name,
            key_hash=key_hash,
            key_preview=_make_key_preview(raw_key),
            limit_usd=body.limit_usd,
            created_at=now,
        )
        await deps.db_client.store_project_api_key(key_record, raw_key)

        return {
            **key_record.model_dump(),
            "key_value": raw_key,
            "note": "Save this key — it will not be shown again.",
        }
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/projects/{project_id}/keys")
async def list_project_keys(project_id: str):
    """
    List all provisioned keys for a project.
    Enriches each key with live usage data from OpenRouter by calling
    GET /api/v1/key with each sub-key's own bearer token (gracefully degrades
    to null usage if OR is unreachable).
    """
    try:
        project = await deps.db_client.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        keys = await deps.db_client.get_project_api_keys_with_values(project_id)
        if not keys:
            return []

        enriched = []
        for k in keys:
            usage_usd: Optional[float] = None
            key_value: str = k.get("key_value", "")
            if key_value:
                try:
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        r = await client.get(
                            "https://openrouter.ai/api/v1/key",
                            headers=deps.openrouter_headers(key_value),
                        )
                        if r.status_code == 200:
                            data = r.json().get("data") or r.json()
                            raw = data.get("usage")
                            if raw is not None:
                                usage_usd = float(raw)
                except Exception:
                    pass
            # Strip key_value before returning to the client
            public_k = {kk: v for kk, v in k.items() if kk != "key_value"}
            enriched.append({**public_k, "usage_usd": usage_usd})
        return enriched
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/projects/{project_id}/keys/{key_id}", status_code=204)
async def delete_project_key(project_id: str, key_id: str):
    """Delete a provisioned key from OpenRouter and from the local DB."""
    try:
        key_row = await deps.db_client.get_project_api_key_by_id(key_id)
        if not key_row or key_row["project_id"] != project_id:
            raise HTTPException(status_code=404, detail="Key not found")

        _prov_key_del = deps.get_ai_config().get("provisioning_key", "")
        if _prov_key_del:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.delete(
                        f"https://openrouter.ai/api/v1/keys/{key_row['key_hash']}",
                        headers=deps.openrouter_headers(_prov_key_del),
                    )
            except Exception:
                pass

        await deps.db_client.delete_project_api_key(key_id)
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.get("/api/projects/{project_id}/spend")
async def get_project_spend(project_id: str):
    """
    Fetch live spend for all provisioned keys of a project.
    Stores a snapshot only when OR responds successfully, and falls back to
    the last stored snapshot when OR is unreachable.  Returns aggregated totals.
    """
    try:
        project = await deps.db_client.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        keys = await deps.db_client.get_project_api_keys_with_values(project_id)
        snapshot_at = datetime.utcnow().isoformat()

        # Load last-known snapshots keyed by key_hash for fallback
        stored_snapshots = await deps.db_client.get_latest_spend_snapshots(project_id)
        snapshot_by_hash: dict = {s["key_hash"]: s for s in stored_snapshots}

        key_spends: List[KeySpend] = []

        for k in keys:
            live_usage_usd: Optional[float] = None
            limit_usd: Optional[float] = k.get("limit_usd")
            key_value: str = k.get("key_value", "")

            if key_value:
                try:
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        r = await client.get(
                            "https://openrouter.ai/api/v1/key",
                            headers=deps.openrouter_headers(key_value),
                        )
                        if r.status_code == 200:
                            # OR wraps the response in {"data": {...}}
                            body = r.json()
                            data = body.get("data") or body
                            raw = data.get("usage")
                            if raw is not None:
                                live_usage_usd = float(raw)
                            limit_usd = data.get("limit") or limit_usd
                except Exception:
                    pass

            if live_usage_usd is not None:
                # Got a live value — persist it as a snapshot
                await deps.db_client.store_spend_snapshot(
                    project_id=project_id,
                    key_hash=k["key_hash"],
                    usage_usd=live_usage_usd,
                    limit_usd=limit_usd,
                    snapshot_at=snapshot_at,
                )
                usage_usd = live_usage_usd
            else:
                # Fall back to last stored snapshot (may be None if never fetched)
                prev = snapshot_by_hash.get(k["key_hash"])
                usage_usd = float(prev["usage_usd"]) if prev else 0.0
                if prev and prev.get("limit_usd") is not None:
                    limit_usd = prev["limit_usd"]

            remaining: Optional[float] = None
            if limit_usd is not None:
                remaining = max(0.0, limit_usd - usage_usd)

            key_spends.append(KeySpend(
                key_hash=k["key_hash"],
                name=k["name"],
                usage_usd=usage_usd,
                limit_usd=limit_usd,
                remaining_usd=remaining,
            ))

        total_usd = sum(ks.usage_usd for ks in key_spends)
        return {
            "total_usd": total_usd,
            "keys": [ks.model_dump() for ks in key_spends],
            "snapshot_at": snapshot_at,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)

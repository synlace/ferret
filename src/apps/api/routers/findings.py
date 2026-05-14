"""
Findings CRUD and findings-scoped AI chat endpoints.
"""

import uuid
import httpx
from datetime import datetime
from fastapi import APIRouter, HTTPException
from typing import Optional

import deps
from models import Finding, FindingCreate, FindingStatusUpdate, ChatSendRequest

router = APIRouter()


@router.get("/api/findings")
async def get_findings(
    severity: Optional[str] = None,
    host: Optional[str] = None,
    type: Optional[str] = None,
    source: Optional[str] = None,
    status: Optional[str] = None,
    project_id: str = "temp",
):
    """List findings with optional filters."""
    try:
        findings = await deps.db_client.get_findings(
            severity=severity, host=host, type_=type, source=source, status=status,
            project_id=project_id,
        )
        return findings
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/findings", status_code=201)
async def create_finding(body: FindingCreate):
    """Create a new finding."""
    try:
        finding = Finding(
            id=str(uuid.uuid4()),
            title=body.title,
            severity=body.severity,
            type=body.type,
            host=body.host,
            request_id=body.request_id,
            source=body.source,
            status="open",
            description=body.description,
            evidence=body.evidence,
            created_at=datetime.utcnow(),
        )
        await deps.db_client.store_finding(finding)
        return finding
    except Exception as e:
        raise deps.server_error(e)


@router.patch("/api/findings/{finding_id}")
async def update_finding(finding_id: str, body: FindingStatusUpdate):
    """Update finding status."""
    try:
        ok = await deps.db_client.update_finding_status(finding_id, body.status)
        if not ok:
            raise HTTPException(status_code=404, detail="Finding not found")
        return {"id": finding_id, "status": body.status}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.delete("/api/findings/{finding_id}", status_code=204)
async def delete_finding(finding_id: str):
    """Delete a finding."""
    try:
        ok = await deps.db_client.delete_finding(finding_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Finding not found")
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)


@router.post("/api/findings/chat")
async def findings_chat(body: ChatSendRequest, project_id: str = "temp"):
    """AI chat scoped to findings context. Uses the provisioned key for the project."""
    try:
        _api_key = await deps.get_key_for_project(project_id)
        if not _api_key:
            raise HTTPException(
                status_code=503,
                detail=f"No provisioned key for project '{project_id}'. Add one via Projects → Keys.",
            )

        findings = await deps.db_client.get_findings()
        findings_summary = "\n".join(
            f"- [{f['severity'].upper()}] {f['title']} ({f['host']}) — {f['status']}"
            for f in findings[:20]
        )
        system_prompt = (
            "You are a security analyst assistant. The user is reviewing security findings "
            "from a MITM proxy tool called FERRET.\n\n"
            f"Current findings ({len(findings)} total):\n{findings_summary}\n\n"
            "Help the user understand, prioritise, and remediate these findings."
        )
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": body.message},
        ]
        model = body.model or deps.OPENROUTER_MODEL
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=deps.openrouter_headers(_api_key),
                json={"model": model, "messages": messages},
            )
            resp.raise_for_status()
            data = resp.json()
        reply = data["choices"][0]["message"]["content"]
        return {"reply": reply}
    except HTTPException:
        raise
    except Exception as e:
        raise deps.server_error(e)

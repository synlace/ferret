"""
Hunt Plans endpoints — filesystem-only implementation.

Plans are reusable prompt templates for automated hunt sessions.

Layout
------
Built-in plans  (read-only, shipped with the app):
    {PLANS_BUILTIN_DIR}/*.md   →  src/apps/api/plans/*.md

User plans  (created/edited/deleted at runtime):
    {PLANS_USER_DIR}/*.md      →  /data/plans/*.md  (host-mounted volume)

Both directories use the same .md format:

    ---
    name: Human-readable plan name
    description: One-line description.
    tool: hunt
    max_tool_calls: 15
    ---

    Prompt body text here.  Supports {{target}} placeholder.

The plan ``id`` is the filename stem (e.g. ``quick_recon`` for
``quick_recon.md``).  Built-in plan IDs are prefixed with ``builtin:``
in the response so the frontend can distinguish them from user plans.

Routes
------
  GET    /api/plans?project_id=…              list all plans (built-ins + user)
  POST   /api/plans                           create a new user plan
  PUT    /api/plans/{plan_id}                 update a user plan
  DELETE /api/plans/{plan_id}?project_id=…   delete a user plan
  POST   /api/plans/{plan_id}/clone           clone a built-in into user plans
"""

import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import deps

router = APIRouter()

# ---------------------------------------------------------------------------
# Front-matter parser (no external YAML dependency)
# ---------------------------------------------------------------------------

def _parse_plan_file(path: Path) -> Optional[dict]:
    """Parse a prompt plan .md file and return a plan dict, or None if invalid."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None

    parts = text.split("---", 2)
    if len(parts) < 3:
        return None

    meta: dict = {}
    for line in parts[1].strip().splitlines():
        if ":" in line:
            key, _, val = line.partition(":")
            meta[key.strip()] = val.strip()

    if "name" not in meta:
        return None

    return {
        "name":                meta["name"],
        "description":         meta.get("description", ""),
        "tool":                meta.get("tool", "hunt"),
        "prompt":              parts[2].strip(),
        "max_tool_calls":      int(meta.get("max_tool_calls", "15")),
        "interpreter":         meta.get("interpreter", ""),
        "max_runtime_seconds": int(meta.get("max_runtime_seconds", "120")),
    }


def _parse_script_plan(yaml_path: Path) -> Optional[dict]:
    """Parse a script plan from a .yaml sidecar + .sh/.py script file.

    The YAML sidecar contains metadata; the script body is in the sibling
    .sh or .py file referenced by the ``script`` key (defaults to same stem + .sh).
    """
    try:
        yaml_text = yaml_path.read_text(encoding="utf-8")
    except OSError:
        return None

    # Minimal YAML parser (key: value lines only — no external dependency)
    meta: dict = {}
    for line in yaml_text.splitlines():
        line = line.strip()
        if line.startswith("#") or not line:
            continue
        if ":" in line:
            key, _, val = line.partition(":")
            meta[key.strip()] = val.strip()

    if "name" not in meta:
        return None

    # Load script body from sibling file
    script_filename = meta.get("script", f"{yaml_path.stem}.sh")
    script_path = yaml_path.parent / script_filename
    try:
        script_body = script_path.read_text(encoding="utf-8")
    except OSError:
        return None

    # Infer interpreter from extension if not specified
    interpreter = meta.get("interpreter", "")
    if not interpreter:
        if script_filename.endswith(".py"):
            interpreter = "python3"
        else:
            interpreter = "bash"

    def _bool_flag(key: str) -> bool:
        return meta.get(key, "false").lower() in ("true", "1", "yes")

    return {
        "name":                  meta["name"],
        "description":           meta.get("description", ""),
        "tool":                  "script",
        "prompt":                script_body,   # script body stored in prompt field
        "max_tool_calls":        0,             # not applicable for script plans
        "interpreter":           interpreter,
        "max_runtime_seconds":   int(meta.get("max_runtime_seconds", "600")),
        # Discovery capabilities — what this plan emits via [FERRET:MANIFEST]
        "discovers_hosts":       _bool_flag("discovers_hosts"),
        "discovers_paths":       _bool_flag("discovers_paths"),
        # Eligibility — what target types this plan can be run against
        "runs_on_hosts":         _bool_flag("runs_on_hosts"),
        "runs_on_paths":         _bool_flag("runs_on_paths"),
        "_script_file":          str(script_path),
    }


def _write_plan_file(path: Path, plan: dict) -> None:
    """Write a prompt plan dict to a .md file with YAML front-matter."""
    path.parent.mkdir(parents=True, exist_ok=True)
    content = (
        "---\n"
        f"name: {plan['name']}\n"
        f"description: {plan.get('description', '')}\n"
        f"tool: {plan.get('tool', 'hunt')}\n"
        f"max_tool_calls: {plan.get('max_tool_calls', 15)}\n"
        "---\n\n"
        f"{plan['prompt']}\n"
    )
    path.write_text(content, encoding="utf-8")


def _safe_slug(name: str) -> str:
    """Convert a plan name to a safe filename slug."""
    slug = re.sub(r"[^a-zA-Z0-9_-]", "_", name.strip().lower())
    return slug[:60] or "plan"


def _load_all_plans() -> list:
    """Return all plans (built-ins first, then user plans), sorted by name.

    Built-in prompt plans:  {PLANS_BUILTIN_DIR}/prompts/*.md
    Built-in script plans:  {PLANS_BUILTIN_DIR}/scripts/*.yaml  (+ sibling .sh/.py)
    Legacy built-in plans:  {PLANS_BUILTIN_DIR}/*.md  (backwards compat)
    User plans:             {PLANS_USER_DIR}/*.md
    """
    plans: list = []

    builtin_dir = deps.PLANS_BUILTIN_DIR

    # Legacy built-in prompt plans (*.md directly in plans/)
    if builtin_dir.exists():
        for md_file in sorted(builtin_dir.glob("*.md")):
            plan = _parse_plan_file(md_file)
            if plan:
                plan["id"] = f"builtin:{md_file.stem}"
                plan["is_builtin"] = True
                plan["created_at"] = None
                plans.append(plan)

    # Built-in prompt plans in plans/prompts/
    prompts_dir = builtin_dir / "prompts"
    if prompts_dir.exists():
        for md_file in sorted(prompts_dir.glob("*.md")):
            plan = _parse_plan_file(md_file)
            if plan:
                plan["id"] = f"builtin:{md_file.stem}"
                plan["is_builtin"] = True
                plan["created_at"] = None
                plans.append(plan)

    # Built-in script plans in plans/scripts/
    scripts_dir = builtin_dir / "scripts"
    if scripts_dir.exists():
        for yaml_file in sorted(scripts_dir.glob("*.yaml")):
            plan = _parse_script_plan(yaml_file)
            if plan:
                plan["id"] = f"builtin:{yaml_file.stem}"
                plan["is_builtin"] = True
                plan["created_at"] = None
                plans.append(plan)

    # User plans (prompt plans only — user script plans not yet supported)
    user_dir = deps.PLANS_USER_DIR
    if user_dir.exists():
        for md_file in sorted(user_dir.glob("*.md")):
            plan = _parse_plan_file(md_file)
            if plan:
                plan["id"] = md_file.stem
                plan["is_builtin"] = False
                try:
                    plan["created_at"] = datetime.fromtimestamp(
                        md_file.stat().st_mtime, tz=timezone.utc
                    ).isoformat()
                except OSError:
                    plan["created_at"] = None
                plans.append(plan)

    return plans


def _find_plan(plan_id: str) -> Optional[dict]:
    """Look up a single plan by ID. Returns None if not found.

    Search order for builtin: prefix:
      1. plans/scripts/{stem}.yaml  (script plans)
      2. plans/prompts/{stem}.md    (prompt plans in subdirectory)
      3. plans/{stem}.md            (legacy prompt plans)
    """
    if plan_id.startswith("builtin:"):
        stem = plan_id[len("builtin:"):]

        # Try script plan first
        yaml_path = deps.PLANS_BUILTIN_DIR / "scripts" / f"{stem}.yaml"
        plan = _parse_script_plan(yaml_path)
        if plan:
            plan["id"] = plan_id
            plan["is_builtin"] = True
            plan["created_at"] = None
            return plan

        # Try prompts subdirectory
        md_path = deps.PLANS_BUILTIN_DIR / "prompts" / f"{stem}.md"
        plan = _parse_plan_file(md_path)
        if plan:
            plan["id"] = plan_id
            plan["is_builtin"] = True
            plan["created_at"] = None
            return plan

        # Legacy: plans/*.md
        legacy_path = deps.PLANS_BUILTIN_DIR / f"{stem}.md"
        plan = _parse_plan_file(legacy_path)
        if plan:
            plan["id"] = plan_id
            plan["is_builtin"] = True
            plan["created_at"] = None
        return plan
    else:
        path = deps.PLANS_USER_DIR / f"{plan_id}.md"
        plan = _parse_plan_file(path)
        if plan:
            plan["id"] = plan_id
            plan["is_builtin"] = False
            try:
                plan["created_at"] = datetime.fromtimestamp(
                    path.stat().st_mtime, tz=timezone.utc
                ).isoformat()
            except OSError:
                plan["created_at"] = None
        return plan


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class PlanCreate(BaseModel):
    name: str
    description: str = ""
    tool: str = "hunt"
    prompt: str
    max_tool_calls: int = 15
    interpreter: str = ""
    max_runtime_seconds: int = 120


class PlanUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    tool: Optional[str] = None
    prompt: Optional[str] = None
    max_tool_calls: Optional[int] = None
    interpreter: Optional[str] = None
    max_runtime_seconds: Optional[int] = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/api/plans")
async def list_plans(project_id: str = "temp"):
    """Return all plans — built-ins first, then user plans."""
    return _load_all_plans()


@router.post("/api/plans", status_code=201)
async def create_plan(body: PlanCreate, project_id: str = "temp"):
    """Create a new user plan and write it to the user plans directory."""
    slug = _safe_slug(body.name)
    # Ensure uniqueness by appending a short UUID suffix if the slug is taken
    user_dir = deps.PLANS_USER_DIR
    user_dir.mkdir(parents=True, exist_ok=True)
    candidate = user_dir / f"{slug}.md"
    if candidate.exists():
        slug = f"{slug}_{uuid.uuid4().hex[:6]}"
        candidate = user_dir / f"{slug}.md"

    plan = {
        "name":           body.name,
        "description":    body.description,
        "tool":           body.tool,
        "prompt":         body.prompt,
        "max_tool_calls": body.max_tool_calls,
    }
    _write_plan_file(candidate, plan)

    plan["id"] = slug
    plan["is_builtin"] = False
    plan["created_at"] = datetime.now(tz=timezone.utc).isoformat()
    return plan


@router.put("/api/plans/{plan_id}")
async def update_plan(plan_id: str, body: PlanUpdate):
    """Update a user plan. Built-in plans cannot be modified."""
    if plan_id.startswith("builtin:"):
        raise HTTPException(status_code=403, detail="Built-in plans cannot be modified")

    path = deps.PLANS_USER_DIR / f"{plan_id}.md"
    existing = _parse_plan_file(path)
    if not existing:
        raise HTTPException(status_code=404, detail="Plan not found")

    updates = body.model_dump(exclude_none=True)
    existing.update(updates)
    _write_plan_file(path, existing)

    existing["id"] = plan_id
    existing["is_builtin"] = False
    try:
        existing["created_at"] = datetime.fromtimestamp(
            path.stat().st_mtime, tz=timezone.utc
        ).isoformat()
    except OSError:
        existing["created_at"] = None
    return existing


@router.delete("/api/plans/{plan_id}", status_code=204)
async def delete_plan(plan_id: str, project_id: str = "temp"):
    """Delete a user plan. Built-in plans cannot be deleted."""
    if plan_id.startswith("builtin:"):
        raise HTTPException(status_code=403, detail="Built-in plans cannot be deleted")

    path = deps.PLANS_USER_DIR / f"{plan_id}.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Plan not found")
    path.unlink()


@router.post("/api/plans/{plan_id}/clone", status_code=201)
async def clone_plan(plan_id: str, project_id: str = "temp"):
    """Clone any plan (built-in or user) into the user plans directory."""
    source = _find_plan(plan_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Plan not found")

    # Build a new slug from the source name
    slug = _safe_slug(source["name"])
    user_dir = deps.PLANS_USER_DIR
    user_dir.mkdir(parents=True, exist_ok=True)
    candidate = user_dir / f"{slug}.md"
    if candidate.exists():
        slug = f"{slug}_{uuid.uuid4().hex[:6]}"
        candidate = user_dir / f"{slug}.md"

    clone = {
        "name":           source["name"],
        "description":    source.get("description", ""),
        "tool":           source.get("tool", "hunt"),
        "prompt":         source["prompt"],
        "max_tool_calls": source.get("max_tool_calls", 15),
    }
    _write_plan_file(candidate, clone)

    clone["id"] = slug
    clone["is_builtin"] = False
    clone["created_at"] = datetime.now(tz=timezone.utc).isoformat()
    return clone

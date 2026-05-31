"""
System Logs endpoints — unified log streaming and filtering from ferret_master.jsonl.
"""

from fastapi import APIRouter, Query, HTTPException
from typing import List, Optional, Dict, Any
from pathlib import Path
import json
import os

import deps

router = APIRouter()

def _get_master_log_path() -> Path:
    workspaces_dir_env = os.getenv("FERRET_WORKSPACES_DIR", "/data/workspaces")
    workspaces_dir = Path(workspaces_dir_env)
    return Path(os.getenv("FERRET_MASTER_LOG", str(workspaces_dir.parent / "ferret_master.jsonl")))

@router.get("/api/logs")
async def get_system_logs(
    level: Optional[str] = Query(None, description="Filter by log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)"),
    component: Optional[str] = Query(None, description="Filter by component name"),
    project_id: Optional[str] = Query(None, description="Filter by Project ID context"),
    workspace_id: Optional[str] = Query(None, description="Filter by Workspace ID context"),
    workflow_id: Optional[str] = Query(None, description="Filter by Workflow ID context"),
    run_id: Optional[str] = Query(None, description="Filter by Run ID context"),
    search: Optional[str] = Query(None, description="Text search on log message"),
    negated_levels: Optional[str] = Query(None, description="Comma-separated levels to exclude"),
    negated_components: Optional[str] = Query(None, description="Comma-separated components/sources to exclude"),
    limit: int = Query(100, ge=1, le=1000, description="Max logs to return"),
    offset: int = Query(0, ge=0, description="Number of logs to skip")
):
    """
    Query unified system logs from ferret_master.jsonl with filtering and pagination.
    """
    log_path = _get_master_log_path()
    if not log_path.exists():
        return {"logs": [], "total": 0, "limit": limit, "offset": offset}

    logs: List[Dict[str, Any]] = []
    
    try:
        # Read the file and parse lines
        with open(log_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
            
        # Parse lines in reverse order (newest logs first)
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                log_entry = json.loads(line)
                
                # Apply filters
                if level:
                    levels_list = [lvl.strip().upper() for lvl in level.split(",") if lvl.strip()]
                    if levels_list and log_entry.get("level", "").upper() not in levels_list:
                        continue
                if component:
                    components_list = [c.strip().lower() for c in component.split(",") if c.strip()]
                    log_comp = log_entry.get("component", "").lower()
                    if components_list and not any(c in log_comp for c in components_list):
                        continue
                
                if negated_levels:
                    neg_levels_list = [nl.strip().upper() for nl in negated_levels.split(",") if nl.strip()]
                    if log_entry.get("level", "").upper() in neg_levels_list:
                        continue
                        
                if negated_components:
                    neg_comps_list = [nc.strip().lower() for nc in negated_components.split(",") if nc.strip()]
                    log_comp = log_entry.get("component", "").lower()
                    if any(nc in log_comp for nc in neg_comps_list):
                        continue
                
                # Context filters
                context = log_entry.get("context", {})
                if project_id and context.get("project_id") != project_id:
                    continue
                if workspace_id and context.get("workspace_id") != workspace_id:
                    continue
                if workflow_id and context.get("workflow_id") != workflow_id:
                    continue
                if run_id and context.get("run_id") != run_id:
                    continue
                
                # Text search filter
                if search and search.lower() not in log_entry.get("message", "").lower():
                    continue
                
                logs.append(log_entry)
            except json.JSONDecodeError:
                continue
                
        total = len(logs)
        paginated_logs = logs[offset : offset + limit]
        
        return {
            "logs": paginated_logs,
            "total": total,
            "limit": limit,
            "offset": offset
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read logs: {str(e)}")

@router.delete("/api/logs")
async def delete_system_logs(
    project_id: Optional[str] = Query(None, description="Optional project ID to only delete logs for a specific project")
):
    """
    Delete system logs. If project_id is specified, only deletes logs for that specific project.
    Otherwise, clears all system logs.
    """
    log_path = _get_master_log_path()
    if not log_path.exists():
        return {"message": "No logs to delete"}

    try:
        if project_id:
            # Read all logs, filter out the ones with the specified project_id
            remaining_lines = []
            with open(log_path, "r", encoding="utf-8") as f:
                for line in f:
                    line_str = line.strip()
                    if not line_str:
                        continue
                    try:
                        log_entry = json.loads(line_str)
                        context = log_entry.get("context", {})
                        if context.get("project_id") != project_id:
                            remaining_lines.append(line)
                    except json.JSONDecodeError:
                        remaining_lines.append(line)
            
            with open(log_path, "w", encoding="utf-8") as f:
                f.writelines(remaining_lines)
            
            return {"message": f"Successfully deleted logs for project {project_id}"}
        else:
            # Clear all logs by truncating the file
            with open(log_path, "w", encoding="utf-8") as f:
                f.truncate(0)
            return {"message": "Successfully cleared all system logs"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete logs: {str(e)}")

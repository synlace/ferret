import contextvars
import logging
import json
import os
from datetime import datetime, timezone
from pathlib import Path

# Thread/Asyncio-safe Context Variables for active workspace/workflow
ctx_project_id: contextvars.ContextVar[str] = contextvars.ContextVar("ctx_project_id", default="")
ctx_workspace_id: contextvars.ContextVar[str] = contextvars.ContextVar("ctx_workspace_id", default="")
ctx_workflow_id: contextvars.ContextVar[str] = contextvars.ContextVar("ctx_workflow_id", default="")
ctx_run_id: contextvars.ContextVar[str] = contextvars.ContextVar("ctx_run_id", default="")


def get_fallback_component_details(component: str, level: str) -> str:
    """Provides high-level, stable, component-only explanations for third-party modules or general logs."""
    comp = component.lower()
    
    # Stable third-party components (Namespaces are fixed and non-fragile)
    if "aiosqlite" in comp or "sqlite" in comp:
        return "Internal SQLite database driver operation managing active connection cursors and query lifecycle events."
    if "uvicorn" in comp:
        return "ASGI web server event managing active HTTP connections, WebSocket frames, or server keep-alive ticks."
    if "mitmproxy" in comp or "proxy" in comp:
        return "Traffic interceptor proxy capturing, decrypting, and logging HTTP requests and responses for active forensic analysis."
    if "docker-shim" in comp or "shim" in comp:
        return "Security sandbox engine auditing, evaluating, and running containerized CLI execution tasks."
        
    # High-level first-party fallback if no explicit "details" are set
    if "chats_engine" in comp or "chats_ai" in comp or "orchestrator" in comp:
        return "AI Agent Orchestrator managing reasoning loops, hunts, or target analysis."
    if "script_execution" in comp or "execution_engine" in comp:
        return "Workflow Executor running background scripts, security scans, or pipeline automation."
    if "session_tunnel" in comp:
        return "Log stream tunnel transporting real-time execution outputs from workspace back to frontend UI."

    # Level-based fallback
    if level.upper() in ("ERROR", "CRITICAL"):
        return f"An error or failure occurred in component '{component}'."
    if level.upper() == "WARNING":
        return f"A non-fatal anomaly or warning was flagged in component '{component}'."
        
    return f"Routine tracing telemetry event from the '{component}' subsystem."


class UnifiedJSONFormatter(logging.Formatter):
    """Formats Python log records into structured JSON lines."""
    def format(self, record: logging.LogRecord) -> str:
        # Retrieve context from ContextVars first, fallback to record attributes, fallback to "system"
        project_id = ctx_project_id.get() or getattr(record, "project_id", None) or "system"
        workspace_id = ctx_workspace_id.get() or getattr(record, "workspace_id", None) or "system"
        workflow_id = ctx_workflow_id.get() or getattr(record, "workflow_id", None) or "system"
        run_id = ctx_run_id.get() or getattr(record, "run_id", None) or "system"

        message = record.getMessage()
        
        # 1. Single source of truth: Get the explicitly passed "details" metadata if present
        details = getattr(record, "details", None)
        
        # 2. Fall back to non-fragile component-only/severity classification if not provided
        if not details:
            details = get_fallback_component_details(record.name, record.levelname)

        log_data = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": record.levelname,
            "component": record.name,
            "message": message,
            "details": details,
            "context": {
                "project_id": project_id,
                "workspace_id": workspace_id,
                "workflow_id": workflow_id,
                "run_id": run_id
            }
        }
        
        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)
            
        return json.dumps(log_data)


def configure_unified_logging():
    """Initializes the master logging targets on application startup."""
    root_logger = logging.getLogger()
    
    # Resolve absolute path to the master log file
    workspaces_dir_env = os.getenv("FERRET_WORKSPACES_DIR", "/data/workspaces")
    workspaces_dir = Path(workspaces_dir_env)
    master_log_path = Path(os.getenv("FERRET_MASTER_LOG", str(workspaces_dir.parent / "ferret_master.jsonl")))
    
    master_log_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Set default log level
    _LOG_LEVEL_STR = os.getenv("FERRET_LOG_LEVEL", "").upper()
    if not _LOG_LEVEL_STR:
        _LOG_LEVEL_STR = "DEBUG" if os.getenv("WATCHFILES_FORCE_POLLING") == "true" else "WARNING"
    _LOG_LEVEL = getattr(logging, _LOG_LEVEL_STR, logging.WARNING)
    root_logger.setLevel(_LOG_LEVEL)

    # Silence excessively verbose third-party loggers (like database and network tracing)
    logging.getLogger("aiosqlite").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)

    # Check if we already configured unified log handlers to avoid duplication on hot reload
    for h in list(root_logger.handlers):
        if isinstance(h, logging.FileHandler) and h.baseFilename == str(master_log_path.resolve()):
            return
            
    # Master JSON Lines File Handler
    file_handler = logging.FileHandler(master_log_path, encoding="utf-8")
    file_handler.setFormatter(UnifiedJSONFormatter())
    file_handler.setLevel(_LOG_LEVEL)
    root_logger.addHandler(file_handler)

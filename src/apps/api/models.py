"""
Pydantic models for FERRET API
"""

from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional, Dict, Any, List
from enum import Enum
from uuid import uuid4


class HttpMethod(str, Enum):
    GET = "GET"
    POST = "POST"
    PUT = "PUT"
    DELETE = "DELETE"
    PATCH = "PATCH"
    HEAD = "HEAD"
    OPTIONS = "OPTIONS"
    TRACE = "TRACE"


class HttpRequest(BaseModel):
    seq: Optional[int] = Field(None, description="Auto-increment row sequence number")
    id: str = Field(..., description="Unique request identifier")
    timestamp: datetime = Field(..., description="Request timestamp")
    method: str = Field(..., description="HTTP method (any verb, e.g. GET, POST, TEST)")
    url: str = Field(..., description="Full URL")
    host: str = Field(..., description="Host header")
    path: str = Field(..., description="URL path")
    query_params: Optional[Dict[str, Any]] = Field(None, description="Query parameters")
    headers: Dict[str, str] = Field(..., description="Request headers")
    body: Optional[str] = Field(None, description="Request body")
    content_type: Optional[str] = Field(None, description="Content-Type header")
    content_length: int = Field(0, description="Content length in bytes")

    # Response data
    status_code: Optional[int] = Field(None, description="HTTP status code")
    response_headers: Optional[Dict[str, str]] = Field(None, description="Response headers")
    response_body: Optional[str] = Field(None, description="Response body")
    response_time: Optional[float] = Field(None, description="Response time in milliseconds")
    response_size: Optional[int] = Field(None, description="Response size in bytes")

    # Metadata
    client_ip: Optional[str] = Field(None, description="Client IP address")
    server_ip: Optional[str] = Field(None, description="Server IP address")
    tls_version: Optional[str] = Field(None, description="TLS version if HTTPS")
    intercepted: bool = Field(False, description="Whether request was intercepted")
    modified: bool = Field(False, description="Whether request was modified")
    annotation: Optional[str] = Field(None, description="AI-generated annotation for this request")
    source: str = Field("proxy", description="Traffic source: 'proxy' (human) or 'test' (automated)")

    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }


class GnawTab(BaseModel):
    """A persisted gnaw tab, scoped to a project."""
    id: str = Field(..., description="Unique tab identifier (UUID)")
    project_id: str = Field("temp", description="Owning project ID")
    label: str = Field(..., description="Display label, e.g. 'GET example.com'")
    position: int = Field(0, description="Ordering position within the project")
    raw_request: Optional[str] = Field(None, description="Raw HTTP request text (editor content)")
    response: Optional[Dict[str, Any]] = Field(None, description="Last response data (status_code, headers, body, time)")
    created_at: str = Field(..., description="ISO-8601 creation timestamp")
    updated_at: str = Field(..., description="ISO-8601 last-updated timestamp")

    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }


class ProxySettings(BaseModel):
    listen_host: str = Field("0.0.0.0", description="Proxy listen address")
    listen_port: int = Field(1337, description="Proxy listen port")
    upstream_cert: bool = Field(True, description="Use upstream certificates")
    ssl_insecure: bool = Field(False, description="Allow insecure SSL connections")
    http2: bool = Field(True, description="Enable HTTP/2 support")
    websocket: bool = Field(True, description="Enable WebSocket support")
    raw_tcp: bool = Field(False, description="Enable raw TCP proxy")
    rawtcp_ports: List[int] = Field([], description="Raw TCP ports")
    transparent: bool = Field(False, description="Transparent proxy mode")
    mode: str = Field("regular", description="Proxy mode (regular, transparent, socks5)")


class SnareRule(BaseModel):
    id: str = Field(..., description="Rule identifier")
    name: str = Field(..., description="Rule name")
    enabled: bool = Field(True, description="Whether rule is enabled")
    method: Optional[HttpMethod] = Field(None, description="HTTP method filter")
    host_pattern: Optional[str] = Field(None, description="Host pattern (regex)")
    path_pattern: Optional[str] = Field(None, description="Path pattern (regex)")
    header_filters: Optional[Dict[str, str]] = Field(None, description="Header filters")
    body_pattern: Optional[str] = Field(None, description="Body content pattern")
    action: str = Field("snare", description="Action to take (snare, drop, modify)")
    created_at: datetime = Field(default_factory=datetime.utcnow)


class SnaredRequest(HttpRequest):
    rule_id: str = Field(..., description="ID of the rule that intercepted this request")
    intercepted_at: datetime = Field(default_factory=datetime.utcnow)
    status: str = Field("pending", description="Intercept status (pending, forwarded, dropped)")


class ProxyStats(BaseModel):
    total_requests: int = Field(0, description="Total number of requests")
    active_connections: int = Field(0, description="Active connections")
    intercepted_requests: int = Field(0, description="Currently intercepted requests")
    uptime: float = Field(0, description="Proxy uptime in seconds")
    data_transferred: int = Field(0, description="Total data transferred in bytes")


class SearchFilter(BaseModel):
    method: Optional[HttpMethod] = None
    status_code: Optional[int] = None
    status_code_range: Optional[tuple[int, int]] = None
    host: Optional[str] = None
    path_pattern: Optional[str] = None
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    has_response: Optional[bool] = None
    content_type: Optional[str] = None
    size_min: Optional[int] = None
    size_max: Optional[int] = None
    source: Optional[str] = None


class WebSocketMessage(BaseModel):
    type: str = Field(..., description="Message type")
    data: Dict[str, Any] = Field(..., description="Message data")
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class HealthStatus(BaseModel):
    status: str = Field(..., description="Service status")
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    details: Optional[Dict[str, Any]] = Field(None, description="Additional status details")


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------

class Finding(BaseModel):
    id: str = Field(..., description="Unique finding identifier")
    title: str = Field(..., description="Short title of the finding")
    severity: str = Field("info", description="Severity: critical, high, medium, low, info")
    type: str = Field("other", description="Finding type: sqli, xss, idor, auth, config, other")
    host: str = Field("", description="Affected host")
    request_id: Optional[str] = Field(None, description="Associated request ID")
    source: str = Field("manual", description="How finding was created: manual, ai, test")
    status: str = Field("open", description="Status: open, confirmed, false_positive, fixed")
    description: Optional[str] = Field(None, description="Detailed description")
    evidence: Optional[str] = Field(None, description="Evidence / PoC")
    created_at: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        json_encoders = {datetime: lambda v: v.isoformat()}


class FindingCreate(BaseModel):
    title: str
    severity: str = "info"
    type: str = "other"
    host: str = ""
    request_id: Optional[str] = None
    source: str = "manual"
    description: Optional[str] = None
    evidence: Optional[str] = None


class FindingStatusUpdate(BaseModel):
    status: str


# ---------------------------------------------------------------------------
# Chat Sessions (multi-chat)
# ---------------------------------------------------------------------------

class ChatSession(BaseModel):
    id: str = Field(..., description="Unique session identifier")
    name: str = Field(..., description="Display name for the chat")
    scope: str = Field("blank", description="Scope: single, host, selected, page, all, blank")
    scope_data: Optional[Dict[str, Any]] = Field(None, description="Scope-specific data (e.g. request_id, host)")
    project_id: str = Field("temp", description="Project this session belongs to")
    workspace_dir: Optional[str] = Field(None, description="Relative path under WORKSPACES_DIR for this workspace")
    created_at: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        json_encoders = {datetime: lambda v: v.isoformat()}


class ChatSessionCreate(BaseModel):
    name: str
    scope: str = "blank"
    scope_data: Optional[Dict[str, Any]] = None


class ChatSessionUpdate(BaseModel):
    name: Optional[str] = None
    scope: Optional[str] = None
    scope_data: Optional[Dict[str, Any]] = None


class ChatSendRequest(BaseModel):
    message: str
    provider: Optional[str] = None
    model: Optional[str] = None
    session_id: Optional[str] = None  # for session-based chat
    max_tool_calls: Optional[int] = None  # max tool-call iterations; None = use server default


# ---------------------------------------------------------------------------
# Test Runs
# ---------------------------------------------------------------------------

class TestRun(BaseModel):
    id: str = Field(..., description="Unique run identifier")
    file: str = Field(..., description="Test file name (relative to TESTS_DIR)")
    test_name: Optional[str] = Field(None, description="Specific test function name, or None for whole file")
    host: str = Field("", description="Target host")
    via_proxy: bool = Field(False, description="Whether to route traffic through FERRET proxy")
    status: str = Field("pending", description="Status: pending, running, passed, failed, error")
    output: Optional[str] = Field(None, description="Combined stdout+stderr from pytest")
    project_id: str = Field("temp", description="Project this run belongs to")
    started_at: Optional[datetime] = Field(None)
    finished_at: Optional[datetime] = Field(None)

    class Config:
        json_encoders = {datetime: lambda v: v.isoformat()}


class TestRunRequest(BaseModel):
    file: str
    test_name: Optional[str] = None
    via_proxy: bool = False


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------

class Project(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    name: str
    description: str = ""
    color: str = "#f97316"
    emoji: str = ""
    labels: List[str] = Field(default_factory=list)
    default_model: str = "google/gemini-3-flash-preview"
    is_temp: bool = False
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        json_encoders = {datetime: lambda v: v.isoformat()}


class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    color: str = "#f97316"
    emoji: str = ""
    labels: List[str] = Field(default_factory=list)
    default_model: str = "google/gemini-3-flash-preview"
    provision_key: bool = True  # auto-provision an OR key on creation


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None
    emoji: Optional[str] = None
    labels: Optional[List[str]] = None
    default_model: Optional[str] = None
    is_temp: Optional[bool] = None


class ProjectExport(BaseModel):
    version: int = 1
    exported_at: datetime = Field(default_factory=datetime.utcnow)
    project: Project
    requests: List[dict] = []
    findings: List[dict] = []
    chat_sessions: List[dict] = []
    test_runs: List[dict] = []

    class Config:
        json_encoders = {datetime: lambda v: v.isoformat()}


# ---------------------------------------------------------------------------
# OpenRouter Provisioned Key Management
# ---------------------------------------------------------------------------

class ProjectApiKey(BaseModel):
    id: str
    project_id: str
    name: str
    key_hash: str          # OpenRouter key hash (used to call OR API)
    key_preview: str       # first 8 + "..." + last 4 chars of the actual key
    limit_usd: Optional[float] = None
    created_at: str


class ProjectApiKeyCreate(BaseModel):
    name: str
    limit_usd: Optional[float] = None  # None = unlimited


class KeySpend(BaseModel):
    key_hash: str
    name: str
    usage_usd: float
    limit_usd: Optional[float] = None
    remaining_usd: Optional[float] = None  # limit - usage if limit set

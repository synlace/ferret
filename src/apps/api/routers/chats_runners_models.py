from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional

class Runner(BaseModel):
    id: str = Field(..., description="Unique runner/container identifier")
    url: Optional[str] = Field(None, description="Runner direct URL / control endpoint if any")
    status: str = Field("active", description="Status of the runner: active|offline")
    last_heartbeat: datetime = Field(default_factory=datetime.utcnow)

class RunnerHeartbeat(BaseModel):
    runner_id: str
    url: Optional[str] = None
    logs: Optional[str] = None

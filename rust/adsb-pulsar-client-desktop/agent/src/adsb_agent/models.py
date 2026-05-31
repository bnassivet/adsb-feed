"""Pydantic request/response models for the ADS-B AG-UI Agent API."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from .voice.base import VoiceBackendStatus


class HealthResponse(BaseModel):
    status: Literal["healthy"]
    service: str


class AgentDescription(BaseModel):
    description: str


class RuntimeInfoResponse(BaseModel):
    agents: dict[str, AgentDescription]


class AgUiRequest(BaseModel):
    method: Literal["info", "agent/run", "agent/connect"]
    params: dict[str, Any] = Field(default_factory=dict)
    body: dict[str, Any] = Field(default_factory=dict)


class AgUiErrorResponse(BaseModel):
    error: str


class VoiceBackendDetail(BaseModel):
    name: str
    description: str
    status: VoiceBackendStatus
    supports_end_to_end: bool
    model_size: str | None = None


class VoiceBackendsResponse(BaseModel):
    backends: dict[str, VoiceBackendDetail]


class VoiceStartRequest(BaseModel):
    backend: Literal["voxtral", "lfm2-audio"] = "voxtral"
    # Optional chat-session id (AG-UI thread_id) — used to tag the resulting
    # MLflow trace so voice traces group under the same session as chat turns.
    session_id: str | None = None


class VoiceStartResponse(BaseModel):
    status: Literal["listening"]
    backend: str


class VoiceErrorResponse(BaseModel):
    error: str


class VoiceStopResponse(BaseModel):
    status: Literal["stopped", "not_listening"]
    backend: str | None = None
    transcript: str | None = None


class VoiceStatusResponse(BaseModel):
    active_backend: str | None
    status: str | None
    backends: dict[str, str]


SSE_RESPONSES: dict[int | str, dict] = {
    200: {
        "description": "Server-Sent Events stream. Each event is a JSON-encoded AG-UI protocol event.",
        "content": {"text/event-stream": {"schema": {"type": "string"}}},
    }
}

VOICE_SSE_RESPONSES: dict[int | str, dict] = {
    200: {
        "description": 'SSE stream of transcript chunks. Each event: {"text": "...", "is_final": bool}',
        "content": {"text/event-stream": {"schema": {"type": "string"}}},
    }
}

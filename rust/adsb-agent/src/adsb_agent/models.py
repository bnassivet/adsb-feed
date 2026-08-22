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


# ---------------------------------------------------------------------------
# Simulation (adsb-simulation-agent, over A2A)
# ---------------------------------------------------------------------------


class SimulateTrajectoryRequest(BaseModel):
    """Form submission from the desktop app's simulation panel.

    Mirrors the `generateSimulatedTrajectory` chat tool's arguments so both
    entry points reach the simulation agent through the same client.
    """

    category: Literal["airliner", "ga", "helicopter", "fighter"]
    origin_lat: float = Field(ge=-90, le=90, alias="originLat")
    origin_lng: float = Field(ge=-180, le=180, alias="originLng")
    count: int = Field(default=1, ge=1, le=20)
    route_hint: str | None = Field(default=None, alias="routeHint")
    """Free text, interpreted by the simulation agent — never pre-structured here."""

    cruise_altitude_ft: int | None = Field(default=None, ge=0, le=60000, alias="cruiseAltitudeFt")

    model_config = {"populate_by_name": True}

    def to_tool_args(self) -> dict[str, Any]:
        """Shape expected by `a2a_client.build_trajectory_payload`."""
        args: dict[str, Any] = {
            "category": self.category,
            "originLat": self.origin_lat,
            "originLng": self.origin_lng,
            "count": self.count,
        }
        if self.route_hint:
            args["routeHint"] = self.route_hint
        if self.cruise_altitude_ft is not None:
            args["cruiseAltitudeFt"] = self.cruise_altitude_ft
        return args


class SimulateTrajectoryResponse(BaseModel):
    """Generated trajectories, ready for the frontend to animate."""

    aircraft: list[dict[str, Any]]
    violations: list[dict[str, Any]] = Field(default_factory=list)
    summary: str


class TrackDigest(BaseModel):
    """One scenario track, summarised for the description generator.

    Deliberately not the waypoints. The desktop app builds this (see
    `scenario-convert.ts::trackDigest`) so the raw arrays never leave it: the
    prompt stays small and the model sees only what a description needs.

    Every geometry field is nullable — a track whose stored waypoints failed to
    parse still has an identity and must still be describable.
    """

    callsign: str
    category: str
    start_offset_s: float = 0
    """Seconds into the scenario before this aircraft appears."""

    route: str | None = None
    """The route hint the aircraft was generated from, when one is known.

    This is what the aircraft was *asked* to do ("orbit the port then land
    downtown"), and it beats anything derivable from the waypoints. When it is
    present the kinematic fields below are left out of the prompt entirely."""

    waypoint_count: int = 0
    duration_s: float = 0
    phases: list[str] = Field(default_factory=list)
    alt_ft_min: float | None = None
    alt_ft_max: float | None = None
    speed_kts_min: float | None = None
    speed_kts_max: float | None = None
    start_lat: float | None = None
    start_lng: float | None = None
    end_lat: float | None = None
    end_lng: float | None = None


class DescribeScenarioRequest(BaseModel):
    """Request from the scenario panel's "Generate from trajectories" button."""

    name: str
    tracks: list[TrackDigest] = Field(default_factory=list)


class DescribeScenarioResponse(BaseModel):
    """Prose the user reviews and edits before saving — never auto-persisted."""

    description: str

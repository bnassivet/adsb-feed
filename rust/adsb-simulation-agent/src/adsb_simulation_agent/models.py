"""Domain models shared across the simulation agent.

The split that matters here: ``RoutePlan`` is *intent* (what the LLM is allowed to
produce — a pattern enum plus scalars), while ``Waypoint``/``TrajectoryResponse``
are *geometry* (synthesized deterministically in Python). The LLM never emits
coordinates; see ``geometry.py``.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class AircraftCategory(str, Enum):
    """Broad performance class, selecting a ``KinematicProfile``."""

    AIRLINER = "airliner"
    GA = "ga"
    HELICOPTER = "helicopter"
    FIGHTER = "fighter"


class RoutePattern(str, Enum):
    """The shape of the ground track, independent of aircraft performance."""

    ORBIT = "orbit"
    """Circular loiter around a point — police/news helicopter, holding pattern."""

    RACETRACK = "racetrack"
    """Two straight legs joined by 180-degree turns — patrol, surveillance."""

    TRANSIT = "transit"
    """Straight-line passage across the area — overflight, cruise leg."""

    APPROACH = "approach"
    """Descending straight-in leg toward a runway threshold."""

    MANEUVER = "maneuver"
    """Aerobatic figure-eight style track — fighter display."""


class FlightPhase(str, Enum):
    """Phase of flight a waypoint belongs to; drives speed/altitude selection."""

    CLIMB = "climb"
    CRUISE = "cruise"
    DESCENT = "descent"
    APPROACH = "approach"
    HOVER = "hover"
    LOITER = "loiter"
    MANEUVER = "maneuver"


class RoutePlan(BaseModel):
    """Structured route intent — the *only* thing the LLM is asked to produce.

    Deliberately free of coordinates: a small local model classifies the request
    into a pattern plus a handful of scalars, and ``geometry.py`` turns that into
    an anchor track. See the plan's "LLM scope" decision.
    """

    pattern: RoutePattern
    category: AircraftCategory
    radius_nm: float = Field(default=3.0, gt=0, le=100)
    """Orbit/racetrack radius, or half-length of a transit/approach leg."""

    bearing_deg: float = Field(default=0.0, ge=0, lt=360)
    """Orientation of the pattern relative to the origin."""

    altitude_ft: float | None = Field(default=None, ge=0, le=60000)
    """Target working altitude; falls back to the category's cruise band."""

    turn_count: int = Field(default=1, ge=1, le=10)
    """Laps for orbit/racetrack, or figures for maneuver."""


class TrajectoryRequest(BaseModel):
    """One generation request, as received over A2A."""

    origin_lat: float = Field(ge=-90, le=90)
    origin_lng: float = Field(ge=-180, le=180)
    category: AircraftCategory
    count: int = Field(default=1, ge=1, le=20)
    route_hint: str | None = None
    """Free text, interpreted by the LLM into a ``RoutePlan``."""

    plan: RoutePlan | None = None
    """Pre-structured intent; when set, the LLM parse step is skipped."""

    cruise_altitude_ft: float | None = Field(default=None, ge=0, le=60000)
    callsign_prefix: str | None = None
    seed: int | None = None
    """Fixes the RNG so a request is reproducible (used heavily in tests)."""


class Waypoint(BaseModel):
    """A single timed point on a generated track."""

    lat: float
    lng: float
    alt_ft: float
    speed_kts: float
    heading_deg: float
    phase: FlightPhase
    t_offset_s: float
    """Seconds since the start of this aircraft's trajectory."""


class SimulatedAircraftTrajectory(BaseModel):
    """One aircraft's complete generated track."""

    hex_ident: str
    callsign: str
    category: AircraftCategory
    waypoints: list[Waypoint]


class Violation(BaseModel):
    """A physical-plausibility breach found by ``validate.py``."""

    kind: str
    """e.g. ``turn_rate``, ``climb_rate``, ``speed_band``."""

    waypoint_index: int
    detail: str


class TrajectoryResponse(BaseModel):
    """The generation result returned over A2A."""

    aircraft: list[SimulatedAircraftTrajectory]
    violations: list[Violation] = Field(default_factory=list)
    """Non-empty only when the retry budget was exhausted; best-effort output."""

    def summary(self) -> str:
        """Compact one-line description for the LLM's ToolMessage.

        The full waypoint payload must never reach the chat model's context —
        it travels out-of-band to the frontend instead (see the plan's
        "Critical mechanics").
        """
        if not self.aircraft:
            return "No aircraft generated."
        total_wp = sum(len(a.waypoints) for a in self.aircraft)
        duration_s = max(
            (a.waypoints[-1].t_offset_s for a in self.aircraft if a.waypoints),
            default=0.0,
        )
        cats = ", ".join(sorted({a.category.value for a in self.aircraft}))
        parts = [
            f"{len(self.aircraft)} aircraft ({cats})",
            f"{total_wp} waypoints",
            f"{duration_s / 60:.0f} min",
        ]
        if self.violations:
            parts.append(f"{len(self.violations)} plausibility warnings")
        return ", ".join(parts)

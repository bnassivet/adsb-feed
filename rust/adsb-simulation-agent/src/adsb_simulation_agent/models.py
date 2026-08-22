"""Domain models shared across the simulation agent.

The split that matters here: ``RoutePlan`` is *intent* (what the LLM is allowed to
produce — a sequence of ``RouteLeg``s, each a pattern enum plus scalars), while
``Waypoint``/``TrajectoryResponse`` are *geometry* (synthesized deterministically
in Python). The LLM may *propose* a leg anchor, but only coordinates it can be
shown to have copied from the user's own words survive ``intent.py``'s
corroboration step; it never invents one. See ``geometry.py``.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, model_validator


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


class SpeedBias(str, Enum):
    """Where within a phase's speed band this leg is flown.

    "Manoeuvering at high speed" is a real part of a route request, but speed is
    still bounded by the category's envelope — the bias picks a point inside the
    band rather than overriding it.
    """

    SLOW = "slow"
    NORMAL = "normal"
    FAST = "fast"


class RouteLeg(BaseModel):
    """One segment of a route: a pattern, optionally pinned to a point.

    Legs are flown in order and joined into a single continuous track, so a
    three-leg plan is one aircraft flying three things in sequence — not three
    aircraft.
    """

    pattern: RoutePattern
    radius_nm: float = Field(default=3.0, gt=0, le=100)
    """Orbit/racetrack radius, or half-length of a transit/approach leg.

    Ignored for an anchored transit/approach, whose length is the actual
    distance to its anchor.
    """

    bearing_deg: float = Field(default=0.0, ge=0, lt=360)
    """Orientation of the pattern. Overridden by the geodesic course when the
    leg is anchored and its pattern is a straight one."""

    altitude_ft: float | None = Field(default=None, ge=0, le=60000)
    """Target working altitude; falls back to the category's cruise band."""

    altitude_min_ft: float | None = Field(default=None, ge=0, le=60000)
    altitude_max_ft: float | None = Field(default=None, ge=0, le=60000)
    """Together these make the leg *oscillate* between the two altitudes
    ("going up and down between 1000 and 3000 feet") instead of holding one."""

    turn_count: int = Field(default=1, ge=1, le=10)
    """Laps for orbit/racetrack, or figures for maneuver."""

    speed_bias: SpeedBias = SpeedBias.NORMAL

    anchor_lat: float | None = Field(default=None, ge=-90, le=90)
    anchor_lng: float | None = Field(default=None, ge=-180, le=180)
    """Where this leg happens. Only ever set from a coordinate the user wrote
    themselves — see ``intent.corroborate_anchors``. ``None`` means "continue
    from wherever the previous leg ended"."""

    @model_validator(mode="after")
    def _order_altitude_band(self) -> RouteLeg:
        """A model that swaps min and max meant a band either way."""
        lo, hi = self.altitude_min_ft, self.altitude_max_ft
        if lo is not None and hi is not None and lo > hi:
            object.__setattr__(self, "altitude_min_ft", hi)
            object.__setattr__(self, "altitude_max_ft", lo)
        return self

    @property
    def has_anchor(self) -> bool:
        """True only when the leg is pinned to a usable point."""
        return self.anchor_lat is not None and self.anchor_lng is not None

    @property
    def oscillates(self) -> bool:
        """True when both band bounds are set and actually span a range."""
        return (
            self.altitude_min_ft is not None
            and self.altitude_max_ft is not None
            and self.altitude_max_ft > self.altitude_min_ft
        )


# The flat scalars a pre-multi-leg ``RoutePlan`` carried. Still accepted, and
# still the shape most callers (and the desktop panel) construct.
_LEG_SCALAR_FIELDS = (
    "pattern",
    "radius_nm",
    "bearing_deg",
    "altitude_ft",
    "altitude_min_ft",
    "altitude_max_ft",
    "turn_count",
    "speed_bias",
    "anchor_lat",
    "anchor_lng",
)


class RoutePlan(BaseModel):
    """Structured route intent — the *only* thing the LLM is asked to produce.

    Deliberately free of *invented* coordinates: a small local model classifies
    the request into a sequence of patterns plus a handful of scalars each, and
    ``geometry.py`` turns that into an anchor track.

    Constructing this with flat scalars (``RoutePlan(pattern=..., radius_nm=...)``)
    builds a one-leg plan, which is what every pre-multi-leg caller does.
    """

    category: AircraftCategory
    legs: list[RouteLeg] = Field(min_length=1)

    @model_validator(mode="before")
    @classmethod
    def _lift_flat_scalars(cls, data: Any) -> Any:
        """Accept the old flat form as a one-leg plan.

        Explicit ``legs`` always win: a caller that supplied both meant the
        legs, and the scalars are then just the leftovers of an older shape.
        """
        if not isinstance(data, dict) or data.get("legs"):
            return data
        scalars = {k: data[k] for k in _LEG_SCALAR_FIELDS if k in data and data[k] is not None}
        if not scalars:
            return data
        rest = {k: v for k, v in data.items() if k not in _LEG_SCALAR_FIELDS}
        return {**rest, "legs": [scalars]}

    # Scalar view of the first leg. Every reader that predates multi-leg routes
    # goes through these, so it degrades to the head of the route rather than
    # breaking. They are properties, not fields — hence ``with_leg`` below,
    # since ``model_copy(update=...)`` cannot touch a property.

    @property
    def pattern(self) -> RoutePattern:
        return self.legs[0].pattern

    @property
    def radius_nm(self) -> float:
        return self.legs[0].radius_nm

    @property
    def bearing_deg(self) -> float:
        return self.legs[0].bearing_deg

    @property
    def altitude_ft(self) -> float | None:
        return self.legs[0].altitude_ft

    @property
    def turn_count(self) -> int:
        return self.legs[0].turn_count

    def with_leg(self, index: int, **updates: Any) -> RoutePlan:
        """Copy the plan with one leg updated. Out-of-range indices are ignored."""
        if not (0 <= index < len(self.legs)):
            return self
        legs = list(self.legs)
        legs[index] = legs[index].model_copy(update=updates)
        return self.model_copy(update={"legs": legs})

    def with_all_legs(self, **updates: Any) -> RoutePlan:
        """Copy the plan with the same update applied to every leg."""
        return self.model_copy(
            update={"legs": [leg.model_copy(update=updates) for leg in self.legs]}
        )


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

    leg_index: int = Field(default=0, ge=0)
    """Which ``RouteLeg`` this point belongs to. Lets a violation be traced back
    to the leg that caused it, and lets the map draw the legs separately."""


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

    leg_index: int | None = None
    """Leg the offending waypoint belongs to, so ``correct_plan`` can widen just
    that leg instead of the whole route."""


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

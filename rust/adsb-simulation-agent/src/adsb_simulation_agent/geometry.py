"""Turn route *intent* into an anchor ground track.

This is where the LLM's structured ``RoutePlan`` becomes actual coordinates —
deterministically, in Python. Keeping coordinate synthesis here (rather than
asking the model for lat/lng directly) is what makes the feature robust on a
small local model: the worst a bad classification can do is pick an odd pattern,
never an off-map or self-intersecting mess.

Anchors are the *shape* only. Altitudes, speeds, timing and turn-rate clamping
are applied downstream in ``trajectory.py``.
"""

from __future__ import annotations

import random

from .kinematics import destination_point
from .models import AircraftCategory, RoutePattern, RoutePlan

LatLng = tuple[float, float]

ORBIT_POINTS_PER_LAP = 24
"""Anchors per orbit lap — 30 degrees apart, fine enough that the turn-rate
clamp downstream rarely needs to subdivide further."""

TRANSIT_POINTS = 5
APPROACH_POINTS = 6
MANEUVER_POINTS_PER_LOBE = 8


def build_anchors(plan: RoutePlan, origin_lat: float, origin_lng: float) -> list[LatLng]:
    """Synthesize the ground track for ``plan``, centred on the origin."""
    match plan.pattern:
        case RoutePattern.ORBIT:
            return _orbit(plan, origin_lat, origin_lng)
        case RoutePattern.RACETRACK:
            return _racetrack(plan, origin_lat, origin_lng)
        case RoutePattern.TRANSIT:
            return _transit(plan, origin_lat, origin_lng)
        case RoutePattern.APPROACH:
            return _approach(plan, origin_lat, origin_lng)
        case RoutePattern.MANEUVER:
            return _maneuver(plan, origin_lat, origin_lng)
    raise ValueError(f"unhandled pattern {plan.pattern}")


def _orbit(plan: RoutePlan, lat: float, lng: float) -> list[LatLng]:
    """A circle of ``radius_nm``, entered at ``bearing_deg``, flown ``turn_count`` times."""
    points: list[LatLng] = []
    total = ORBIT_POINTS_PER_LAP * plan.turn_count
    for i in range(total + 1):  # +1 closes the final lap back to the entry point
        angle = plan.bearing_deg + (360.0 * i / ORBIT_POINTS_PER_LAP)
        points.append(destination_point(lat, lng, angle, plan.radius_nm))
    return points


def _racetrack(plan: RoutePlan, lat: float, lng: float) -> list[LatLng]:
    """Two parallel legs joined by 180-degree turns.

    The legs run along ``bearing_deg``, offset either side of the origin by a
    quarter of the radius, so the pattern stays compact around the point of
    interest rather than sprawling.
    """
    half_leg = plan.radius_nm
    offset = plan.radius_nm * 0.25
    fwd, back = plan.bearing_deg, plan.bearing_deg + 180.0
    right, left = plan.bearing_deg + 90.0, plan.bearing_deg - 90.0

    # Corner points of the oval, in flight order.
    a = destination_point(*destination_point(lat, lng, back, half_leg), right, offset)
    b = destination_point(*destination_point(lat, lng, fwd, half_leg), right, offset)
    c = destination_point(*destination_point(lat, lng, fwd, half_leg), left, offset)
    d = destination_point(*destination_point(lat, lng, back, half_leg), left, offset)

    points: list[LatLng] = []
    for _lap in range(plan.turn_count):
        points.extend([a, b, c, d])
    points.append(a)  # close the pattern
    return points


def _transit(plan: RoutePlan, lat: float, lng: float) -> list[LatLng]:
    """A straight line crossing the origin along ``bearing_deg``."""
    start = destination_point(lat, lng, plan.bearing_deg + 180.0, plan.radius_nm)
    points: list[LatLng] = []
    span = plan.radius_nm * 2.0
    for i in range(TRANSIT_POINTS):
        travelled = span * i / (TRANSIT_POINTS - 1)
        points.append(destination_point(*start, plan.bearing_deg, travelled))
    return points


def _approach(plan: RoutePlan, lat: float, lng: float) -> list[LatLng]:
    """A straight-in final ending at the origin.

    ``bearing_deg`` is the inbound course, so the aircraft starts out on the
    reciprocal side and flies toward the field.
    """
    start = destination_point(lat, lng, plan.bearing_deg + 180.0, plan.radius_nm)
    points: list[LatLng] = []
    for i in range(APPROACH_POINTS):
        travelled = plan.radius_nm * i / (APPROACH_POINTS - 1)
        points.append(destination_point(*start, plan.bearing_deg, travelled))
    return points


def _maneuver(plan: RoutePlan, lat: float, lng: float) -> list[LatLng]:
    """A figure-eight — two opposing lobes that cross back over the origin.

    Each lobe is a circle of half the requested radius, centred half a radius
    out along (and against) the pattern bearing, so the track passes through the
    origin twice per figure.
    """
    lobe_r = plan.radius_nm / 2.0
    points: list[LatLng] = []

    for figure in range(plan.turn_count):
        for lobe, (centre_bearing, direction) in enumerate(
            ((plan.bearing_deg, 1.0), (plan.bearing_deg + 180.0, -1.0))
        ):
            centre = destination_point(lat, lng, centre_bearing, lobe_r)
            # Start each lobe at the origin side so consecutive lobes join up.
            entry = centre_bearing + 180.0
            for i in range(MANEUVER_POINTS_PER_LOBE + 1):
                angle = entry + direction * (360.0 * i / MANEUVER_POINTS_PER_LOBE)
                pt = destination_point(*centre, angle, lobe_r)
                # Skip the duplicated joint between lobes/figures.
                if points and (figure or lobe) and i == 0:
                    continue
                points.append(pt)
    return points


# Which patterns suit which category when the user gave no route hint.
_DEFAULT_PATTERNS: dict[AircraftCategory, tuple[RoutePattern, ...]] = {
    AircraftCategory.AIRLINER: (RoutePattern.TRANSIT, RoutePattern.APPROACH),
    AircraftCategory.GA: (RoutePattern.TRANSIT, RoutePattern.ORBIT, RoutePattern.APPROACH),
    AircraftCategory.HELICOPTER: (RoutePattern.ORBIT, RoutePattern.RACETRACK),
    AircraftCategory.FIGHTER: (RoutePattern.MANEUVER, RoutePattern.RACETRACK),
}

# Radius bands (NM) that keep each category's track on a local-area map.
_DEFAULT_RADIUS_NM: dict[AircraftCategory, tuple[float, float]] = {
    AircraftCategory.AIRLINER: (12.0, 25.0),
    AircraftCategory.GA: (4.0, 12.0),
    AircraftCategory.HELICOPTER: (1.5, 6.0),
    AircraftCategory.FIGHTER: (6.0, 15.0),
}


def default_plan_for(category: AircraftCategory, seed: int | None = None) -> RoutePlan:
    """Pick a plausible route plan when the caller supplied no hint.

    Seeded so a request is reproducible — tests depend on this, and it lets a
    user regenerate the same scenario.
    """
    rng = random.Random(seed)
    lo, hi = _DEFAULT_RADIUS_NM[category]
    return RoutePlan(
        pattern=rng.choice(_DEFAULT_PATTERNS[category]),
        category=category,
        radius_nm=round(rng.uniform(lo, hi), 2),
        bearing_deg=round(rng.uniform(0.0, 359.9), 1),
        altitude_ft=None,
        turn_count=rng.randint(1, 3),
    )

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

import math
import random

from .kinematics import bearing_deg, destination_point, great_circle_nm
from .models import AircraftCategory, RouteLeg, RoutePattern, RoutePlan

LatLng = tuple[float, float]

ORBIT_POINTS_PER_LAP = 24
"""Anchors per orbit lap — 30 degrees apart, fine enough that the turn-rate
clamp downstream rarely needs to subdivide further."""

TRANSIT_POINTS = 5
APPROACH_POINTS = 6
MANEUVER_POINTS_PER_LOBE = 8


JOIN_TOLERANCE_NM = 0.05
"""Below this, two points are the same place and no connector is needed."""

# Patterns that are a route *to* somewhere, as opposed to a shape *around*
# somewhere. Only these reinterpret an anchor as a destination.
_STRAIGHT_PATTERNS = (RoutePattern.TRANSIT, RoutePattern.APPROACH)


def resolve_anchor(leg: RouteLeg, previous_end: LatLng | None, origin: LatLng) -> LatLng:
    """Where this leg happens.

    An explicit anchor wins; otherwise the leg continues from wherever the
    previous one ended, and the first leg falls back to the request origin.
    This is what "a bare place name is ignored" means in practice — an
    uncorroborated anchor never reaches here, so the leg simply carries on.
    """
    if leg.has_anchor:
        return (float(leg.anchor_lat), float(leg.anchor_lng))  # type: ignore[arg-type]
    return previous_end if previous_end is not None else origin


def _leg_to_point(start: LatLng, end: LatLng, points: int) -> list[LatLng]:
    """A straight run from ``start`` to ``end``, sampled evenly.

    Used for an anchored transit/approach — its length is the real distance to
    the anchor, so ``radius_nm`` does not apply.
    """
    course = bearing_deg(*start, *end)
    span = great_circle_nm(*start, *end)
    if span <= JOIN_TOLERANCE_NM:
        return [start, end]
    return [destination_point(*start, course, span * i / (points - 1)) for i in range(points)]


def build_leg_anchors(
    leg: RouteLeg, anchor: LatLng, previous_end: LatLng | None, is_first: bool
) -> list[LatLng]:
    """Synthesize one leg's ground track.

    Two behaviours, chosen by whether the leg is pinned:

    * An **anchored straight leg** runs from the hand-over point *to* the
      anchor. This is what makes "coming from A ... then going towards C"
      expressible; the pattern library has no A-to-B primitive otherwise.
    * Everything else keeps the original centred-on-a-point synthesis, so
      single-leg plans are unchanged.

    A pattern anchored away from the hand-over point gets a straight connector
    prepended, so the track never teleports between legs.
    """
    lat, lng = anchor

    if leg.has_anchor and leg.pattern in _STRAIGHT_PATTERNS and previous_end is not None:
        points = TRANSIT_POINTS if leg.pattern == RoutePattern.TRANSIT else APPROACH_POINTS
        return _leg_to_point(previous_end, anchor, points)

    # A pattern being joined from elsewhere is entered tangentially rather than
    # at its nominal bearing, so the run-in doesn't leave an unflyable corner.
    joining = previous_end is not None and not (is_first and not leg.has_anchor)

    match leg.pattern:
        case RoutePattern.ORBIT:
            entry = (
                tangential_entry_angle(anchor, leg.radius_nm, previous_end)  # type: ignore[arg-type]
                if joining
                else None
            )
            points = _orbit(leg, lat, lng, start_angle=entry)
        case RoutePattern.RACETRACK:
            points = _racetrack(leg, lat, lng)
        case RoutePattern.TRANSIT:
            points = _transit(leg, lat, lng)
        case RoutePattern.APPROACH:
            points = _approach(leg, lat, lng)
        case RoutePattern.MANEUVER:
            points = _maneuver(leg, lat, lng)
        case _:  # pragma: no cover — the enum is exhaustive
            raise ValueError(f"unhandled pattern {leg.pattern}")

    # Join up with whatever came before. Skipped for an unanchored first leg so
    # the historical single-leg output is reproduced exactly.
    if (
        previous_end is not None
        and joining
        and great_circle_nm(*previous_end, *points[0]) > JOIN_TOLERANCE_NM
    ):
        points = [previous_end, *_line_up(points, leg.radius_nm), *points]

    return points


def _line_up(points: list[LatLng], radius_nm: float) -> list[LatLng]:
    """A short alignment segment placed ahead of a pattern's first point.

    Without it the run-in arrives at the pattern from whatever direction the
    previous leg happened to end in, and the whole heading change lands on the
    single corner at the pattern's entry — which is exactly where there is least
    room to absorb it. Extending the pattern's own initial course backwards
    gives the aircraft somewhere to roll out before it gets there, spreading the
    turn over two gentle corners instead of one sharp one.

    Sized from the pattern's radius, which by this point has already been grown
    to something the category can fly (``feasible_leg_radius_nm``), so the
    line-up is always at least a turn radius long.
    """
    if len(points) < 2:
        return []
    entry_course = bearing_deg(*points[0], *points[1])
    return [destination_point(*points[0], entry_course + 180.0, radius_nm)]


def _extent_nm(points: list[LatLng]) -> float:
    """How far the leg actually reaches from its start point."""
    return max(great_circle_nm(*points[0], *p) for p in points)


def build_indexed_leg_anchors(
    plan: RoutePlan, origin_lat: float, origin_lng: float
) -> list[tuple[int, list[LatLng]]]:
    """``build_multi_leg_anchors``, keeping each leg's index in ``plan.legs``.

    The index has to survive because degenerate legs are dropped, so position in
    the result no longer matches position in the plan — and ``trajectory.py``
    stamps that index onto every waypoint, which is what lets a violation be
    traced back to the leg that caused it.
    """
    origin = (origin_lat, origin_lng)
    previous_end: LatLng | None = origin
    legs: list[tuple[int, list[LatLng]]] = []

    for index, leg in enumerate(plan.legs):
        anchor = resolve_anchor(leg, previous_end, origin)
        points = build_leg_anchors(leg, anchor, previous_end, is_first=index == 0)
        # Drop a leg that goes nowhere — a straight leg anchored at the point
        # the aircraft is already at. Easy for a model to emit ("fly to X" when
        # the previous leg ended at X), and keeping it would feed a run of
        # coincident points downstream, where headings are undefined and the
        # rounding produces nonsense. Measured as the leg's *extent*, since a
        # closed pattern legitimately ends where it started.
        if len(points) < 2 or _extent_nm(points) <= JOIN_TOLERANCE_NM:
            continue
        legs.append((index, points))
        previous_end = points[-1]

    return legs


def build_multi_leg_anchors(
    plan: RoutePlan, origin_lat: float, origin_lng: float
) -> list[list[LatLng]]:
    """Synthesize every leg in order, threading each leg's end into the next.

    Returns one point list per leg — kept separate rather than flattened so
    ``trajectory.py`` can hang a different altitude, speed and turn radius off
    each one.
    """
    return [points for _, points in build_indexed_leg_anchors(plan, origin_lat, origin_lng)]


def build_anchors(plan: RoutePlan, origin_lat: float, origin_lng: float) -> list[LatLng]:
    """The whole route as one flat polyline.

    Kept for callers that don't care about leg boundaries.
    """
    return [p for leg in build_multi_leg_anchors(plan, origin_lat, origin_lng) for p in leg]


def _orbit(
    plan: RouteLeg, lat: float, lng: float, start_angle: float | None = None
) -> list[LatLng]:
    """A circle of ``radius_nm``, entered at ``bearing_deg``, flown ``turn_count`` times.

    ``start_angle`` overrides the entry point, which is how a tangential join is
    arranged — see ``tangential_entry_angle``.
    """
    points: list[LatLng] = []
    total = ORBIT_POINTS_PER_LAP * plan.turn_count
    entry = plan.bearing_deg if start_angle is None else start_angle
    for i in range(total + 1):  # +1 closes the final lap back to the entry point
        angle = entry + (360.0 * i / ORBIT_POINTS_PER_LAP)
        points.append(destination_point(lat, lng, angle, plan.radius_nm))
    return points


def tangential_entry_angle(centre: LatLng, radius_nm: float, approach_from: LatLng) -> float | None:
    """Angle from ``centre`` at which a run-in from ``approach_from`` meets the circle.

    Aircraft join a circular pattern *tangentially* — a straight-in leg that
    strikes the circle side-on leaves a corner the pattern's own radius cannot
    absorb, which for an airliner (a 2.4 NM minimum turn radius at cruise) is
    simply unflyable.

    In the right triangle formed by the centre C, the approach point P and the
    tangent point T, the right angle is at T, so ``cos(TCP) = R / d`` and T sits
    ``acos(R / d)`` either side of the bearing from C to P. Every angle here is
    measured *at the centre*, in the circle's own local frame — measuring the
    run-in at P instead compares bearings thousands of miles apart, where
    great-circle convergence makes them disagree by tens of degrees.

    Of the two tangents, the one kept is whichever leaves the aircraft already
    turning the way the orbit sweeps; rolling out onto the reciprocal would just
    move the unflyable corner rather than remove it.

    ``None`` when the approach point is inside the circle, where no tangent
    exists and the entry angle is a free choice anyway.
    """
    distance = great_circle_nm(*centre, *approach_from)
    if distance <= radius_nm:
        return None

    to_approach = bearing_deg(*centre, *approach_from)
    offset = math.degrees(math.acos(max(-1.0, min(1.0, radius_nm / distance))))

    best_angle: float | None = None
    best_kink = 1e9
    for angle in (to_approach - offset, to_approach + offset):
        touch = destination_point(*centre, angle, radius_nm)
        # Arrival course at the tangent point, and where the orbit goes next.
        arrival = bearing_deg(*touch, *approach_from) + 180.0
        onward = bearing_deg(*touch, *destination_point(*centre, angle + 15.0, radius_nm))
        kink = abs((onward - arrival + 180.0) % 360.0 - 180.0)
        if kink < best_kink:
            best_kink, best_angle = kink, angle

    return best_angle


def _racetrack(plan: RouteLeg, lat: float, lng: float) -> list[LatLng]:
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


def _transit(plan: RouteLeg, lat: float, lng: float) -> list[LatLng]:
    """A straight line crossing the origin along ``bearing_deg``."""
    start = destination_point(lat, lng, plan.bearing_deg + 180.0, plan.radius_nm)
    points: list[LatLng] = []
    span = plan.radius_nm * 2.0
    for i in range(TRANSIT_POINTS):
        travelled = span * i / (TRANSIT_POINTS - 1)
        points.append(destination_point(*start, plan.bearing_deg, travelled))
    return points


def _approach(plan: RouteLeg, lat: float, lng: float) -> list[LatLng]:
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


def _maneuver(plan: RouteLeg, lat: float, lng: float) -> list[LatLng]:
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

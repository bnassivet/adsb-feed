"""Turn an anchor ground track into timed, flyable waypoints.

The pipeline, and why it is in this order:

1. **Round the corners.** Anchors from ``geometry.py`` are a polyline with sharp
   vertices. Real aircraft fly *arcs* through turns, so each corner is replaced
   by an arc whose radius comes from the category's turn rate at its speed. This
   is what enforces DC3's turn-rate rule structurally — a track sampled along an
   arc of radius ``v/omega`` and flown at ``v`` turns at exactly ``omega``.
2. **Resample by distance.** Walk the rounded path emitting a point roughly
   every ``WAYPOINT_INTERVAL_S`` of flight time.
3. **Hang phase, altitude and speed off route progress**, clamping vertical rate
   to the profile.
4. **Derive timing from geometry** — never the other way round. The old
   hand-authored demo flights had a ``ground_speed`` field with no relationship
   to how fast the icon actually moved; here speed *is* distance over time.
"""

from __future__ import annotations

import math
import random
from collections.abc import Callable
from dataclasses import dataclass
from itertools import pairwise

from .geometry import build_indexed_leg_anchors, default_plan_for
from .kinematics import (
    PROFILES,
    Band,
    KinematicProfile,
    bearing_deg,
    destination_point,
    great_circle_nm,
    normalize_heading,
    turn_radius_nm,
)
from .models import (
    AircraftCategory,
    FlightPhase,
    RouteLeg,
    RoutePattern,
    RoutePlan,
    SimulatedAircraftTrajectory,
    SpeedBias,
    TrajectoryRequest,
    TrajectoryResponse,
    Waypoint,
)

LatLng = tuple[float, float]

WAYPOINT_INTERVAL_S = 8.0
"""Target spacing between emitted waypoints. Fine enough that the frontend's
linear interpolation between them is visually smooth."""

ARC_POINTS_PER_TURN = 6
"""Points used to describe one rounded corner."""

MIN_TURN_DEG = 2.0
"""Heading changes below this are left as-is — not worth an arc."""


# --------------------------------------------------------------------------
# Step 1 — corner rounding
# --------------------------------------------------------------------------


def round_corners(points: list[LatLng], turn_radius_nm: float) -> list[LatLng]:
    """Replace sharp vertices with circular arcs of ``turn_radius_nm``.

    Standard "fly-by waypoint" construction: the arc leaves the inbound leg a
    tangent distance ``R * tan(theta/2)`` before the vertex and rejoins the
    outbound leg the same distance after it. The radius is shrunk per-corner
    when the adjacent legs are too short to accommodate it, so tight patterns
    degrade gracefully instead of overshooting.
    """
    rounded, _ = round_corners_tagged(points, [0] * len(points), lambda _index: turn_radius_nm)
    return rounded


def round_corners_tagged(
    points: list[LatLng],
    tags: list[int],
    radius_for: Callable[[int], float],
) -> tuple[list[LatLng], list[int]]:
    """``round_corners``, but carrying a per-point leg tag through the rounding.

    Two things make this necessary on a multi-leg route. The turn radius is a
    function of *speed*, so a leg flown fast needs wider corners than the one
    before it — hence ``radius_for(vertex_index)`` rather than a single radius.
    And the tags have to survive, because arcs insert points and dedupe drops
    them, so the caller can no longer recover which leg an output point came
    from by index alone.
    """
    if len(points) < 3:
        return list(points), list(tags)

    out: list[LatLng] = [points[0]]
    out_tags: list[int] = [tags[0]]

    for i, (prev, vertex, nxt) in enumerate(zip(points, points[1:], points[2:])):
        tag = tags[i + 1]
        turn_radius_nm = radius_for(i + 1)
        in_bearing = bearing_deg(*prev, *vertex)
        out_bearing = bearing_deg(*vertex, *nxt)
        turn = (out_bearing - in_bearing + 180.0) % 360.0 - 180.0

        if abs(turn) < MIN_TURN_DEG:
            out.append(vertex)
            out_tags.append(tag)
            continue

        leg_in = great_circle_nm(*prev, *vertex)
        leg_out = great_circle_nm(*vertex, *nxt)
        # Never consume more than half of either adjacent leg.
        max_tangent = min(leg_in, leg_out) / 2.0
        tangent = min(turn_radius_nm * abs(math.tan(math.radians(turn) / 2.0)), max_tangent)
        if tangent <= 1e-9:
            out.append(vertex)
            out_tags.append(tag)
            continue

        arc_start = destination_point(*vertex, in_bearing + 180.0, tangent)
        arc_end = destination_point(*vertex, out_bearing, tangent)

        # Effective radius after any clamping: R = tangent / tan(theta/2).
        effective_r = tangent / abs(math.tan(math.radians(turn) / 2.0))
        # The turn centre lies perpendicular to the inbound leg at arc_start,
        # on the inside of the turn.
        perp = in_bearing + (90.0 if turn > 0 else -90.0)
        centre = destination_point(*arc_start, perp, effective_r)

        # Sweep from centre-to-arc_start round to centre-to-arc_end. Stepping by
        # true angle about the centre is what makes this an actual circular arc
        # of radius R — so flying it at speed v yields exactly v/R turn rate.
        start_angle = bearing_deg(*centre, *arc_start)
        out.append(arc_start)
        out_tags.append(tag)
        for j in range(1, ARC_POINTS_PER_TURN):
            angle = start_angle + turn * (j / ARC_POINTS_PER_TURN)
            out.append(destination_point(*centre, angle, effective_r))
            out_tags.append(tag)
        out.append(arc_end)
        out_tags.append(tag)

    out.append(points[-1])
    out_tags.append(tags[-1])
    return _dedupe(out, out_tags)


def _dedupe(
    points: list[LatLng], tags: list[int], tol_nm: float = 1e-6
) -> tuple[list[LatLng], list[int]]:
    """Drop consecutive duplicates — they make heading undefined."""
    cleaned: list[LatLng] = []
    cleaned_tags: list[int] = []
    for p, tag in zip(points, tags):
        if not cleaned or great_circle_nm(*cleaned[-1], *p) > tol_nm:
            cleaned.append(p)
            cleaned_tags.append(tag)
    return cleaned, cleaned_tags


# --------------------------------------------------------------------------
# Step 3 — phase / altitude planning
# --------------------------------------------------------------------------

PhaseSpan = tuple[FlightPhase, float, float]
"""``(phase, start_fraction, end_fraction)`` over total route distance."""


def phase_plan_for_leg(
    leg: RouteLeg,
    category: AircraftCategory,
    is_first: bool,
    is_last: bool,
) -> list[PhaseSpan]:
    """How one leg divides into phases of flight.

    On a multi-leg route the climb belongs to the first leg and the descent to
    the last — an interior transit is cruise all the way through, because the
    aircraft is already up and is not coming down yet. A single leg is both
    first and last, which reproduces ``phase_plan`` exactly; that equivalence is
    what keeps single-leg output unchanged.
    """
    base = phase_plan(leg.pattern, category)
    if is_first and is_last:
        return base

    # Level patterns (orbit/racetrack/maneuver) are unaffected by their position
    # in the route — they are what they are wherever they happen.
    if leg.pattern in (RoutePattern.ORBIT, RoutePattern.RACETRACK, RoutePattern.MANEUVER):
        return base

    # An approach is a descent by definition, wherever it sits.
    if leg.pattern == RoutePattern.APPROACH:
        return base

    if is_first:
        # "Coming from (46.49, -1.79) at 10000 ft" describes an aircraft that is
        # already established when the scenario picks it up — it entered the
        # area, it did not take off from that point. So a first leg with a
        # stated altitude starts level at it rather than climbing to it.
        if leg.altitude_ft is not None:
            return [(FlightPhase.CRUISE, 0.0, 1.0)]
        return [(FlightPhase.CLIMB, 0.0, 0.3), (FlightPhase.CRUISE, 0.3, 1.0)]
    if is_last:
        return [(FlightPhase.CRUISE, 0.0, 0.7), (FlightPhase.DESCENT, 0.7, 1.0)]
    return [(FlightPhase.CRUISE, 0.0, 1.0)]


def phase_plan(pattern: RoutePattern, category: AircraftCategory) -> list[PhaseSpan]:
    """How a whole single-leg route divides into phases of flight.

    Rotorcraft loiter rather than cruise; fighters flying a display are
    manoeuvring throughout; an approach is descent then final.
    """
    if pattern == RoutePattern.APPROACH:
        return [(FlightPhase.DESCENT, 0.0, 0.6), (FlightPhase.APPROACH, 0.6, 1.0)]

    if pattern == RoutePattern.MANEUVER:
        return [(FlightPhase.MANEUVER, 0.0, 1.0)]

    if category == AircraftCategory.HELICOPTER:
        if pattern in (RoutePattern.ORBIT, RoutePattern.RACETRACK):
            return [(FlightPhase.LOITER, 0.0, 1.0)]
        return [
            (FlightPhase.CLIMB, 0.0, 0.15),
            (FlightPhase.CRUISE, 0.15, 0.85),
            (FlightPhase.DESCENT, 0.85, 1.0),
        ]

    if pattern in (RoutePattern.ORBIT, RoutePattern.RACETRACK):
        return [(FlightPhase.LOITER, 0.0, 1.0)]

    # TRANSIT for fixed-wing: a full climb / cruise / descent profile.
    return [
        (FlightPhase.CLIMB, 0.0, 0.2),
        (FlightPhase.CRUISE, 0.2, 0.8),
        (FlightPhase.DESCENT, 0.8, 1.0),
    ]


def _phase_at(plan: list[PhaseSpan], fraction: float) -> tuple[FlightPhase, float]:
    """The phase covering ``fraction``, plus progress *within* that phase."""
    for phase, start, end in plan:
        if fraction <= end or (phase, start, end) == plan[-1]:
            span = max(end - start, 1e-9)
            return phase, min(1.0, max(0.0, (fraction - start) / span))
    phase, start, end = plan[-1]
    return phase, 1.0


def _speed_band(profile: KinematicProfile, phase: FlightPhase) -> Band:
    match phase:
        case FlightPhase.CLIMB:
            return profile.climb_speed_kts
        case FlightPhase.DESCENT:
            return profile.descent_speed_kts
        case FlightPhase.APPROACH:
            return profile.approach_speed_kts
        case FlightPhase.HOVER:
            return (profile.approach_speed_kts[0], profile.approach_speed_kts[1])
        case _:
            return profile.cruise_speed_kts


def _mid(band: Band) -> float:
    return (band[0] + band[1]) / 2.0


def _biased_speed(band: Band, bias: SpeedBias) -> float:
    """Pick a speed inside the phase's band.

    The bias moves *within* the envelope rather than past it: "at high speed"
    means the top of what the category can do, not permission to exceed it. The
    turn radius used for corner rounding is derived from this same number, so a
    fast leg gets correspondingly wider corners and still validates clean.
    """
    match bias:
        case SpeedBias.FAST:
            return band[1]
        case SpeedBias.SLOW:
            return band[0]
        case _:
            return _mid(band)


def leg_speed_kts(profile: KinematicProfile, leg: RouteLeg) -> float:
    """Representative speed for a leg, used for sizing its turns."""
    return max(_biased_speed(profile.cruise_speed_kts, leg.speed_bias), 1.0)


# --------------------------------------------------------------------------
# Step 2 + 4 — resampling and timing
# --------------------------------------------------------------------------


def _cumulative_distances(points: list[LatLng]) -> list[float]:
    dists = [0.0]
    for a, b in pairwise(points):
        dists.append(dists[-1] + great_circle_nm(*a, *b))
    return dists


def _point_at_distance(points: list[LatLng], cum: list[float], target_nm: float) -> LatLng:
    """Linear interpolation along the polyline at ``target_nm`` from the start."""
    if target_nm <= 0:
        return points[0]
    if target_nm >= cum[-1]:
        return points[-1]
    for i in range(len(cum) - 1):
        if cum[i] <= target_nm <= cum[i + 1]:
            leg = cum[i + 1] - cum[i]
            if leg <= 1e-12:
                return points[i]
            frac = (target_nm - cum[i]) / leg
            brg = bearing_deg(*points[i], *points[i + 1])
            return destination_point(*points[i], brg, leg * frac)
    return points[-1]


_MIN_RADIUS_MULTIPLE: dict[RoutePattern, float] = {
    # An orbit is one continuous turn, so its radius *is* the turn radius.
    RoutePattern.ORBIT: 1.0,
    # A racetrack's 180s happen across the leg offset (0.5 * radius), which must
    # fit two turn radii.
    RoutePattern.RACETRACK: 4.0,
    # Each figure-eight lobe is half the pattern radius.
    RoutePattern.MANEUVER: 2.0,
    # Straight lines impose no turning constraint.
    RoutePattern.TRANSIT: 0.0,
    RoutePattern.APPROACH: 0.0,
}


TURN_FEASIBILITY_MARGIN = 1.15
"""Headroom on the smallest pattern a category can fly.

Sizing a pattern to *exactly* the minimum turn radius means flying it at exactly
the sustained maximum turn rate for its entire length, with nothing left for the
8-second sampling grid — the heading change measured between two waypoints then
reads above the limit even though the underlying arc is legal. It is also not a
plausible way to fly: nobody holds a continuous max-rate turn for a whole orbit.
Most visible on airliners, whose 3 deg/s limit at 450 kts already forces a
~2.4 NM minimum radius.
"""


def feasible_leg_radius_nm(leg: RouteLeg, profile: KinematicProfile) -> float:
    """Grow one leg's pattern until its turns are flyable for this category.

    A 3 deg/s limit at 450 kts means an airliner physically cannot turn inside
    ~2.4 NM, so a 6 NM racetrack is not an airliner racetrack no matter how it
    is drawn. Enlarging the pattern is the honest fix — the alternative is
    emitting a track that violates its own performance envelope.

    A leg flown fast needs *more* room, which is why the speed here is the
    leg's biased speed rather than the profile's mid-cruise.
    """
    min_turn_r = turn_radius_nm(leg_speed_kts(profile, leg), profile.max_turn_rate_dps)
    required = min_turn_r * _MIN_RADIUS_MULTIPLE[leg.pattern] * TURN_FEASIBILITY_MARGIN
    return max(leg.radius_nm, required)


def feasible_radius_nm(plan: RoutePlan, profile: KinematicProfile) -> float:
    """``feasible_leg_radius_nm`` for a whole single-leg plan."""
    return feasible_leg_radius_nm(plan.legs[0], profile)


@dataclass
class _LegSpan:
    """One leg's slice of the concatenated route, with its own flight plan."""

    index: int
    leg: RouteLeg
    phases: list[PhaseSpan]
    start_nm: float
    end_nm: float
    working_alt: float

    @property
    def length_nm(self) -> float:
        return max(self.end_nm - self.start_nm, 1e-9)

    def progress(self, travelled_nm: float) -> float:
        """How far through this leg ``travelled_nm`` is, as 0..1."""
        return min(1.0, max(0.0, (travelled_nm - self.start_nm) / self.length_nm))


LEG_JOIN_TURN_MARGIN = 0.7
"""Fraction of the maximum turn rate a *leg change* is flown at.

A corner sized to exactly ``v / omega_max`` turns at exactly the limit, which
leaves nothing for sampling error: waypoints land every 8 s, and a step can span
most of a tight arc, so the heading change measured between two of them reads
higher than the instantaneous rate. Inside a pattern that is harmless because
the pattern's own radius is already generous, but a leg join can be a near
reversal onto a new heading. Flying those at 70% of the limit buys the margin —
and matches how the turn would really be flown, since changing route is a
discretionary manoeuvre rather than part of the display.
"""


MAX_SINGLE_TURN_DEG = 150.0
"""Beyond this, a corner is a reversal and cannot be rounded in place.

The fly-by construction puts the arc a tangent distance ``R * tan(theta/2)``
from the vertex, and ``tan`` diverges as ``theta`` approaches 180 degrees — so
the tangent clamps to half the adjacent leg and the *effective* radius collapses
toward zero. The corner then comes out sharper the closer it is to a true
reversal, which is exactly backwards. Aircraft don't reverse on the spot either;
they fly a procedure turn, offset to one side. See ``_split_reversals``.
"""


def _split_reversals(
    points: list[LatLng], tags: list[int], radius_for: Callable[[int], float]
) -> tuple[list[LatLng], list[int]]:
    """Turn near-reversals into two ordinary turns, offset to one side.

    Inserting a single point ``2R`` abeam the vertex converts one impossible
    180-degree corner into two roughly-90-degree ones, which round normally.
    Geometrically this is a procedure turn: the aircraft flies past, turns
    through the reversal displaced laterally, and rolls out on the reciprocal.
    """
    if len(points) < 3:
        return list(points), list(tags)

    out: list[LatLng] = [points[0]]
    out_tags: list[int] = [tags[0]]

    for i, (prev, vertex, nxt) in enumerate(zip(points, points[1:], points[2:])):
        index = i + 1
        in_bearing = bearing_deg(*prev, *vertex)
        out_bearing = bearing_deg(*vertex, *nxt)
        turn = (out_bearing - in_bearing + 180.0) % 360.0 - 180.0

        out.append(vertex)
        out_tags.append(tags[index])

        if abs(turn) >= MAX_SINGLE_TURN_DEG:
            side = 90.0 if turn >= 0 else -90.0
            offset = destination_point(*vertex, in_bearing + side, 2.0 * radius_for(index))
            out.append(offset)
            out_tags.append(tags[index])

    out.append(points[-1])
    out_tags.append(tags[-1])
    return out, out_tags


def _is_leg_join(tags: list[int], index: int) -> bool:
    """True when this vertex sits on the boundary between two legs."""
    before = tags[index - 1] if index > 0 else tags[index]
    after = tags[index + 1] if index + 1 < len(tags) else tags[index]
    return before != tags[index] or after != tags[index]


def _build_route_path(
    plan: RoutePlan,
    origin_lat: float,
    origin_lng: float,
    profile: KinematicProfile,
) -> tuple[list[LatLng], list[int], list[float]]:
    """Anchors for every leg, corner-rounded, concatenated and tagged by leg."""
    legs = build_indexed_leg_anchors(plan, origin_lat, origin_lng)

    anchors: list[LatLng] = []
    tags: list[int] = []
    for index, points in legs:
        # Each leg starts where the previous one ended, so the join point
        # appears twice. It must be dropped *before* rounding: a duplicated
        # vertex gives the corner a zero-length inbound leg, which clamps its
        # tangent to zero — and the corner is then left completely unrounded.
        # The sharp turn survives into the output and breaches the turn rate.
        start = 1 if anchors and great_circle_nm(*anchors[-1], *points[0]) <= 1e-6 else 0
        anchors.extend(points[start:])
        tags.extend([index] * len(points[start:]))

    if len(anchors) < 2:
        return [], [], []

    def radius_for(index: int) -> float:
        leg = plan.legs[min(tags[index], len(plan.legs) - 1)]
        radius = turn_radius_nm(leg_speed_kts(profile, leg), profile.max_turn_rate_dps)
        if _is_leg_join(tags, index):
            radius /= LEG_JOIN_TURN_MARGIN
        return radius

    anchors, tags = _split_reversals(anchors, tags, radius_for)
    path, path_tags = round_corners_tagged(anchors, tags, radius_for)
    return path, path_tags, _cumulative_distances(path)


def _leg_bounds(tags: list[int], cum: list[float], leg_count: int) -> list[tuple[float, float]]:
    """Distance range each leg occupies along the rounded path.

    Tags are non-decreasing (legs are flown in order), so each leg's points are
    contiguous and its bounds are just the cumulative distance at its first and
    last point.
    """
    bounds: list[tuple[float, float]] = []
    for index in range(leg_count):
        indices = [i for i, tag in enumerate(tags) if tag == index]
        if not indices:
            # A leg that contributed no path (degenerate geometry) gets a zero
            # -length slice so lookups still land somewhere sensible.
            previous_end = bounds[-1][1] if bounds else 0.0
            bounds.append((previous_end, previous_end))
            continue
        bounds.append((cum[indices[0]], cum[indices[-1]]))
    if bounds:
        bounds[-1] = (bounds[-1][0], cum[-1])
    return bounds


def build_waypoints(
    plan: RoutePlan,
    origin_lat: float,
    origin_lng: float,
    profile: KinematicProfile,
    cruise_altitude_ft: float | None,
    rng: random.Random,
) -> list[Waypoint]:
    """The full pipeline for one aircraft, across every leg of its route."""
    single_leg = len(plan.legs) == 1

    # Enlarge each pattern first if this category cannot turn tightly enough.
    plan = plan.model_copy(
        update={
            "legs": [
                leg.model_copy(update={"radius_nm": feasible_leg_radius_nm(leg, profile)})
                for leg in plan.legs
            ]
        }
    )

    path, tags, cum = _build_route_path(plan, origin_lat, origin_lng, profile)
    if not path or cum[-1] <= 0:
        return []

    bounds = _leg_bounds(tags, cum, len(plan.legs))
    phases_by_leg = [
        phase_plan_for_leg(leg, plan.category, is_first=i == 0, is_last=i == len(plan.legs) - 1)
        for i, leg in enumerate(plan.legs)
    ]

    # An explicitly requested altitude is a hard requirement, so stretch the
    # pattern until the climb/descent actually fits rather than silently
    # levelling off low. An *anchored* leg cannot be stretched — its length is
    # the distance between two points the user named — so it is left alone and
    # the altitude gets capped by what the leg affords instead.
    scales = [
        _scale_for_altitude(
            _requested_altitude(leg, cruise_altitude_ft, single_leg) or 0.0,
            phases_by_leg[i],
            profile,
            bounds[i][1] - bounds[i][0],
        )
        if _requested_altitude(leg, cruise_altitude_ft, single_leg) is not None
        and not leg.has_anchor
        else 1.0
        for i, leg in enumerate(plan.legs)
    ]
    if any(scale > 1.001 for scale in scales):
        plan = plan.model_copy(
            update={
                "legs": [
                    leg.model_copy(update={"radius_nm": leg.radius_nm * scale})
                    for leg, scale in zip(plan.legs, scales)
                ]
            }
        )
        path, tags, cum = _build_route_path(plan, origin_lat, origin_lng, profile)
        if not path or cum[-1] <= 0:
            return []
        bounds = _leg_bounds(tags, cum, len(plan.legs))

    total_nm = cum[-1]

    spans: list[_LegSpan] = []
    for index, leg in enumerate(plan.legs):
        start_nm, end_nm = bounds[index]
        spans.append(
            _LegSpan(
                index=index,
                leg=leg,
                phases=phases_by_leg[index],
                start_nm=start_nm,
                end_nm=end_nm,
                working_alt=_working_altitude(
                    leg,
                    phases_by_leg[index],
                    profile,
                    _requested_altitude(leg, cruise_altitude_ft, single_leg),
                    max(end_nm - start_nm, 1e-9),
                    rng,
                ),
            )
        )

    def span_at(travelled_nm: float) -> _LegSpan:
        for span in spans:
            if travelled_nm < span.end_nm:
                return span
        return spans[-1]

    waypoints: list[Waypoint] = []
    travelled = 0.0
    elapsed = 0.0
    guard = 0

    while travelled < total_nm and guard < 10_000:
        guard += 1
        span = span_at(travelled)
        fraction = span.progress(travelled)
        phase, phase_progress = _phase_at(span.phases, fraction)
        speed_kts = max(_biased_speed(_speed_band(profile, phase), span.leg.speed_bias), 1.0)

        alt = _leg_altitude(span, phase, phase_progress, fraction, profile, speed_kts)
        pt = _point_at_distance(path, cum, travelled)

        step_nm = speed_kts * (WAYPOINT_INTERVAL_S / 3600.0)
        nxt = _point_at_distance(path, cum, min(travelled + step_nm, total_nm))
        heading = (
            bearing_deg(*pt, *nxt)
            if great_circle_nm(*pt, *nxt) > 1e-9
            else (waypoints[-1].heading_deg if waypoints else span.leg.bearing_deg)
        )

        waypoints.append(
            Waypoint(
                lat=pt[0],
                lng=pt[1],
                alt_ft=round(alt, 1),
                speed_kts=round(speed_kts, 1),
                heading_deg=round(normalize_heading(heading), 1),
                phase=phase,
                t_offset_s=round(elapsed, 2),
                leg_index=span.index,
            )
        )
        travelled += step_nm
        elapsed += WAYPOINT_INTERVAL_S

    # Always finish exactly on the last anchor.
    if waypoints:
        last = spans[-1]
        last_phase, _ = _phase_at(last.phases, 1.0)
        final_speed = max(_biased_speed(_speed_band(profile, last_phase), last.leg.speed_bias), 1.0)
        end = path[-1]
        remaining = great_circle_nm(waypoints[-1].lat, waypoints[-1].lng, *end)
        if remaining > 1e-6:
            waypoints.append(
                Waypoint(
                    lat=end[0],
                    lng=end[1],
                    alt_ft=round(
                        _leg_altitude(last, last_phase, 1.0, 1.0, profile, final_speed), 1
                    ),
                    speed_kts=round(final_speed, 1),
                    heading_deg=waypoints[-1].heading_deg,
                    phase=last_phase,
                    t_offset_s=round(
                        waypoints[-1].t_offset_s + remaining / final_speed * 3600.0, 2
                    ),
                    leg_index=last.index,
                )
            )

    return _clamp_vertical_rate(waypoints, profile)


def _requested_altitude(
    leg: RouteLeg, cruise_altitude_ft: float | None, single_leg: bool
) -> float | None:
    """The altitude this leg is being *asked* for, if any.

    On a single-leg route the request-level ``cruise_altitude_ft`` keeps its
    historical precedence. On a multi-leg route each leg speaks for itself —
    "at 10000 ft" on the way in and "between 1000 and 3000 ft" over the target
    are different requests, and a single route-wide altitude cannot express
    both. An oscillating leg works around the middle of its band.
    """
    if single_leg:
        return cruise_altitude_ft
    if leg.oscillates:
        return (float(leg.altitude_min_ft) + float(leg.altitude_max_ft)) / 2.0  # type: ignore[arg-type]
    return leg.altitude_ft if leg.altitude_ft is not None else cruise_altitude_ft


OSCILLATION_MARGIN = 1.1
"""Slack on the shortest permissible oscillation period, so the sinusoid's peak
vertical rate stays clear of the profile limit rather than sitting on it."""


def _oscillation_altitude(
    leg: RouteLeg, profile: KinematicProfile, leg_nm: float, speed_kts: float, progress: float
) -> float:
    """Altitude on a leg asked to cycle between two heights.

    The cycle count comes from what the leg's duration affords: a sinusoid of
    amplitude ``band/2`` and period ``T`` peaks at ``pi * band / T`` ft/s, so the
    shortest period the aircraft can actually fly is ``pi * band / rate``. Fewer,
    slower cycles is the honest degradation — the alternative is a sawtooth the
    aircraft cannot follow, which the vertical clamp would then flatten anyway.
    """
    lo = float(leg.altitude_min_ft)  # type: ignore[arg-type]
    hi = float(leg.altitude_max_ft)  # type: ignore[arg-type]
    band = hi - lo

    rate_fps = min(profile.climb_rate_fpm[1], profile.descent_rate_fpm[1]) / 60.0
    min_period_s = math.pi * band / max(rate_fps, 1e-6) * OSCILLATION_MARGIN
    leg_time_s = leg_nm / max(speed_kts, 1.0) * 3600.0
    cycles = max(1.0, math.floor(leg_time_s / max(min_period_s, 1e-6)))

    # Starts at the bottom of the band and climbs first, which is what "going up
    # and down between X and Y" describes.
    return lo + band * (0.5 - 0.5 * math.cos(2.0 * math.pi * cycles * progress))


def _leg_altitude(
    span: _LegSpan,
    phase: FlightPhase,
    phase_progress: float,
    leg_progress: float,
    profile: KinematicProfile,
    speed_kts: float,
) -> float:
    """Altitude at a point on a leg — oscillating, or the usual phase ramp."""
    if span.leg.oscillates:
        return _oscillation_altitude(span.leg, profile, span.length_nm, speed_kts, leg_progress)
    return _altitude_for(phase, phase_progress, span.working_alt, profile)


MAX_ROUTE_STRETCH = 12.0
"""Cap on how far a pattern may be enlarged to fit a requested altitude, so an
absurd request (a helicopter at FL350) can't produce a route spanning a continent."""

ALTITUDE_FIT_MARGIN = 1.25
"""Slack on the stretch calculation. Waypoints land on a discrete time grid, so
a route sized to *exactly* the climb requirement leaves the ramp a step short
and the vertical-rate clamp then limits how fast cruise can catch up."""


def _scale_for_altitude(
    target_ft: float,
    phases: list[PhaseSpan],
    profile: KinematicProfile,
    total_nm: float,
) -> float:
    """Factor by which the route must grow for its climb/descent to reach ``target_ft``.

    Distance needed = climb time at the profile's rate, flown at the phase's
    speed. Divided by the phase's share of the route, that gives the total route
    length required.
    """
    floor = _altitude_floor(profile)
    delta_ft = abs(target_ft - floor)
    if delta_ft <= 0 or total_nm <= 0:
        return 1.0

    required_nm = 0.0
    for phase, start, end in phases:
        if phase not in (FlightPhase.CLIMB, FlightPhase.DESCENT, FlightPhase.APPROACH):
            continue
        share = max(end - start, 1e-6)
        rate_fpm = (
            profile.climb_rate_fpm[1] if phase == FlightPhase.CLIMB else profile.descent_rate_fpm[1]
        )
        speed_kts = _mid(_speed_band(profile, phase))
        phase_time_s = delta_ft / rate_fpm * 60.0
        phase_nm = speed_kts * phase_time_s / 3600.0
        required_nm = max(required_nm, phase_nm / share)

    return min(max(required_nm * ALTITUDE_FIT_MARGIN / total_nm, 1.0), MAX_ROUTE_STRETCH)


def _working_altitude(
    plan: RouteLeg,
    phases: list[PhaseSpan],
    profile: KinematicProfile,
    requested_ft: float | None,
    total_nm: float,
    rng: random.Random,
) -> float:
    """Choose a working altitude the aircraft can actually reach on this route.

    Descending 5000 ft at 700 fpm takes ~7 minutes; a 6 NM final at 100 kts
    lasts ~4. Picking altitude independently of route length is what produced
    approaches that never reached the ground. So: work out how long the vertical
    phases last, and cap the altitude to what that time affords.
    """
    floor = _altitude_floor(profile)
    ceiling = requested_ft or plan.altitude_ft or rng.uniform(*profile.cruise_alt_ft)

    # Only clamp to the cruise band when the caller didn't ask for something
    # specific — an approach legitimately operates below the cruise floor.
    if requested_ft is None and plan.pattern != RoutePattern.APPROACH:
        ceiling = min(max(ceiling, profile.cruise_alt_ft[0]), profile.cruise_alt_ft[1])

    # Longest vertical phase share of the route, and the rate available to it.
    vertical = [
        (phase, end - start)
        for phase, start, end in phases
        if phase in (FlightPhase.CLIMB, FlightPhase.DESCENT, FlightPhase.APPROACH)
    ]
    if not vertical:
        return ceiling

    nominal_kts = _mid(profile.cruise_speed_kts)
    total_time_s = total_nm / max(nominal_kts, 1.0) * 3600.0

    achievable = ceiling
    for phase, share in vertical:
        rate_fpm = (
            profile.climb_rate_fpm[1] if phase == FlightPhase.CLIMB else profile.descent_rate_fpm[1]
        )
        available_ft = rate_fpm * (total_time_s * share / 60.0)
        achievable = min(achievable, floor + available_ft)

    return max(achievable, floor)


def _altitude_floor(profile: KinematicProfile) -> float:
    """Altitude a climb starts from / a descent bottoms out at."""
    return min(profile.cruise_alt_ft[0] * 0.25, 500.0)


def _altitude_for(
    phase: FlightPhase,
    progress: float,
    working_alt: float,
    profile: KinematicProfile,
) -> float:
    """Altitude at a given point within a phase.

    Climb/descent ramp between ground-ish and the working altitude; level phases
    hold it. The vertical-rate clamp afterwards guarantees the ramps are
    achievable at this category's climb/descent performance.
    """
    floor = _altitude_floor(profile)
    match phase:
        case FlightPhase.CLIMB:
            return floor + (working_alt - floor) * progress
        case FlightPhase.DESCENT:
            return working_alt - (working_alt - floor) * progress
        case FlightPhase.APPROACH:
            # Continues from where the descent handed over, down to the surface.
            return max(floor * (1.0 - progress), 0.0)
        case FlightPhase.HOVER:
            return floor
        case _:
            return working_alt


def _clamp_vertical_rate(waypoints: list[Waypoint], profile: KinematicProfile) -> list[Waypoint]:
    """Walk forward limiting each altitude step to the profile's climb/descent rate.

    Ramps computed from route *fraction* can be steeper than the aircraft can
    fly when a phase is geometrically short. Rather than reject the track, the
    altitude is dragged toward the target as fast as performance allows.
    """
    for prev, cur in pairwise(waypoints):
        dt_min = (cur.t_offset_s - prev.t_offset_s) / 60.0
        if dt_min <= 0:
            continue
        delta = cur.alt_ft - prev.alt_ft
        limit_fpm = profile.climb_rate_fpm[1] if delta > 0 else profile.descent_rate_fpm[1]
        max_delta = limit_fpm * dt_min
        if abs(delta) > max_delta:
            cur.alt_ft = round(prev.alt_ft + math.copysign(max_delta, delta), 1)
    return waypoints


# --------------------------------------------------------------------------
# Public entry point
# --------------------------------------------------------------------------

_CALLSIGN_STEMS: dict[AircraftCategory, str] = {
    AircraftCategory.AIRLINER: "ACA",
    AircraftCategory.GA: "CGA",
    AircraftCategory.HELICOPTER: "HELI",
    AircraftCategory.FIGHTER: "CF",
}


FORMATION_SPREAD_NM = 0.8
"""How far apart formation members are placed around a shared anchor.

Big enough to be visibly several aircraft, small enough that they are still
plainly doing the same thing over the same point."""


def _vary_plan(plan: RoutePlan, rng: random.Random) -> RoutePlan:
    """Vary a plan for an additional aircraft so the formation doesn't stack.

    Unanchored legs are free to be rotated and resized. An **anchored** leg is
    not: the coordinates came from the user, and scattering aircraft off them
    would answer a different question than the one asked. Those legs get a small
    lateral offset instead — a formation over the point, rather than one line
    through it.
    """
    legs: list[RouteLeg] = []
    # Legs that share an anchor must be offset by the *same* amount. Offsetting
    # them independently pulls a leg's start away from where the previous one
    # ended, leaving a stub connector that then has to be turned through far
    # too tightly — which showed up as turn-rate violations on formations.
    offsets: dict[tuple[float, float], LatLng] = {}

    for leg in plan.legs:
        if leg.has_anchor:
            anchor = (float(leg.anchor_lat), float(leg.anchor_lng))  # type: ignore[arg-type]
            key = (round(anchor[0], 6), round(anchor[1], 6))
            if key not in offsets:
                offsets[key] = destination_point(
                    *anchor,
                    rng.uniform(0.0, 360.0),
                    rng.uniform(FORMATION_SPREAD_NM * 0.5, FORMATION_SPREAD_NM),
                )
            lat, lng = offsets[key]
            legs.append(leg.model_copy(update={"anchor_lat": lat, "anchor_lng": lng}))
        else:
            legs.append(
                leg.model_copy(
                    update={
                        "bearing_deg": normalize_heading(
                            leg.bearing_deg + rng.uniform(20.0, 340.0)
                        ),
                        "radius_nm": max(0.5, leg.radius_nm * rng.uniform(0.6, 1.4)),
                    }
                )
            )
    return plan.model_copy(update={"legs": legs})


def generate_trajectory(request: TrajectoryRequest) -> TrajectoryResponse:
    """Generate ``request.count`` trajectories around the requested origin.

    Deterministic for a given ``seed`` so a scenario can be reproduced.
    """
    rng = random.Random(request.seed)
    profile = PROFILES[request.category]
    aircraft: list[SimulatedAircraftTrajectory] = []

    for i in range(request.count):
        # Each extra aircraft gets its own plan variation so they don't stack.
        if request.plan is not None and i == 0:
            plan = request.plan
        elif request.plan is not None:
            plan = _vary_plan(request.plan, rng)
        else:
            plan = default_plan_for(request.category, seed=rng.randrange(1 << 30))

        waypoints = build_waypoints(
            plan,
            request.origin_lat,
            request.origin_lng,
            profile,
            request.cruise_altitude_ft,
            rng,
        )
        if not waypoints:
            continue

        stem = request.callsign_prefix or _CALLSIGN_STEMS[request.category]
        aircraft.append(
            SimulatedAircraftTrajectory(
                hex_ident=f"SIM-{rng.randrange(0x100000, 0xFFFFFF):06X}",
                callsign=f"{stem}{i + 1:03d}",
                category=request.category,
                waypoints=waypoints,
            )
        )

    return TrajectoryResponse(aircraft=aircraft)

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
from itertools import pairwise

from .geometry import build_anchors, default_plan_for
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
    RoutePattern,
    RoutePlan,
    SimulatedAircraftTrajectory,
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
    if len(points) < 3:
        return list(points)

    out: list[LatLng] = [points[0]]
    for prev, vertex, nxt in zip(points, points[1:], points[2:]):
        in_bearing = bearing_deg(*prev, *vertex)
        out_bearing = bearing_deg(*vertex, *nxt)
        turn = (out_bearing - in_bearing + 180.0) % 360.0 - 180.0

        if abs(turn) < MIN_TURN_DEG:
            out.append(vertex)
            continue

        leg_in = great_circle_nm(*prev, *vertex)
        leg_out = great_circle_nm(*vertex, *nxt)
        # Never consume more than half of either adjacent leg.
        max_tangent = min(leg_in, leg_out) / 2.0
        tangent = min(turn_radius_nm * abs(math.tan(math.radians(turn) / 2.0)), max_tangent)
        if tangent <= 1e-9:
            out.append(vertex)
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
        for i in range(1, ARC_POINTS_PER_TURN):
            angle = start_angle + turn * (i / ARC_POINTS_PER_TURN)
            out.append(destination_point(*centre, angle, effective_r))
        out.append(arc_end)

    out.append(points[-1])
    return _dedupe(out)


def _dedupe(points: list[LatLng], tol_nm: float = 1e-6) -> list[LatLng]:
    """Drop consecutive duplicates — they make heading undefined."""
    cleaned: list[LatLng] = []
    for p in points:
        if not cleaned or great_circle_nm(*cleaned[-1], *p) > tol_nm:
            cleaned.append(p)
    return cleaned


# --------------------------------------------------------------------------
# Step 3 — phase / altitude planning
# --------------------------------------------------------------------------

PhaseSpan = tuple[FlightPhase, float, float]
"""``(phase, start_fraction, end_fraction)`` over total route distance."""


def phase_plan(pattern: RoutePattern, category: AircraftCategory) -> list[PhaseSpan]:
    """How the route divides into phases of flight.

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


def feasible_radius_nm(plan: RoutePlan, profile: KinematicProfile) -> float:
    """Grow the pattern until its turns are flyable for this category.

    A 3 deg/s limit at 450 kts means an airliner physically cannot turn inside
    ~2.4 NM, so a 6 NM racetrack is not an airliner racetrack no matter how it
    is drawn. Enlarging the pattern is the honest fix — the alternative is
    emitting a track that violates its own performance envelope.
    """
    min_turn_r = turn_radius_nm(_mid(profile.cruise_speed_kts), profile.max_turn_rate_dps)
    required = min_turn_r * _MIN_RADIUS_MULTIPLE[plan.pattern]
    return max(plan.radius_nm, required)


def build_waypoints(
    plan: RoutePlan,
    origin_lat: float,
    origin_lng: float,
    profile: KinematicProfile,
    cruise_altitude_ft: float | None,
    rng: random.Random,
) -> list[Waypoint]:
    """The full pipeline for one aircraft."""
    # Enlarge the pattern first if this category cannot turn tightly enough.
    plan = plan.model_copy(update={"radius_nm": feasible_radius_nm(plan, profile)})
    anchors = build_anchors(plan, origin_lat, origin_lng)
    phases = phase_plan(plan.pattern, plan.category)

    # Round corners using the radius implied by this category's turn rate at a
    # representative speed — this is what makes the turn-rate limit hold.
    nominal_speed = _mid(profile.cruise_speed_kts)
    radius = turn_radius_nm(nominal_speed, profile.max_turn_rate_dps)
    path = round_corners(anchors, radius)
    cum = _cumulative_distances(path)
    total_nm = cum[-1]
    if total_nm <= 0:
        return []

    # An explicitly requested altitude is a hard requirement, so stretch the
    # pattern until the climb/descent actually fits rather than silently
    # levelling off low.
    if cruise_altitude_ft is not None:
        scale = _scale_for_altitude(cruise_altitude_ft, phases, profile, total_nm)
        if scale > 1.001:
            plan = plan.model_copy(update={"radius_nm": plan.radius_nm * scale})
            anchors = build_anchors(plan, origin_lat, origin_lng)
            path = round_corners(anchors, radius)
            cum = _cumulative_distances(path)
            total_nm = cum[-1]

    working_alt = _working_altitude(plan, phases, profile, cruise_altitude_ft, total_nm, rng)

    waypoints: list[Waypoint] = []
    travelled = 0.0
    elapsed = 0.0
    guard = 0

    while travelled < total_nm and guard < 10_000:
        guard += 1
        fraction = travelled / total_nm
        phase, phase_progress = _phase_at(phases, fraction)
        speed = _speed_band(profile, phase)
        speed_kts = max(_mid(speed), 1.0)

        alt = _altitude_for(phase, phase_progress, working_alt, profile)
        pt = _point_at_distance(path, cum, travelled)

        step_nm = speed_kts * (WAYPOINT_INTERVAL_S / 3600.0)
        nxt = _point_at_distance(path, cum, min(travelled + step_nm, total_nm))
        heading = (
            bearing_deg(*pt, *nxt)
            if great_circle_nm(*pt, *nxt) > 1e-9
            else (waypoints[-1].heading_deg if waypoints else plan.bearing_deg)
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
            )
        )
        travelled += step_nm
        elapsed += WAYPOINT_INTERVAL_S

    # Always finish exactly on the last anchor.
    if waypoints:
        last_phase, _ = _phase_at(phases, 1.0)
        final_speed = max(_mid(_speed_band(profile, last_phase)), 1.0)
        end = path[-1]
        remaining = great_circle_nm(waypoints[-1].lat, waypoints[-1].lng, *end)
        if remaining > 1e-6:
            waypoints.append(
                Waypoint(
                    lat=end[0],
                    lng=end[1],
                    alt_ft=round(_altitude_for(last_phase, 1.0, working_alt, profile), 1),
                    speed_kts=round(final_speed, 1),
                    heading_deg=waypoints[-1].heading_deg,
                    phase=last_phase,
                    t_offset_s=round(
                        waypoints[-1].t_offset_s + remaining / final_speed * 3600.0, 2
                    ),
                )
            )

    return _clamp_vertical_rate(waypoints, profile)


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
    plan: RoutePlan,
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
            plan = request.plan.model_copy(
                update={
                    "bearing_deg": normalize_heading(
                        request.plan.bearing_deg + rng.uniform(20.0, 340.0)
                    ),
                    "radius_nm": max(0.5, request.plan.radius_nm * rng.uniform(0.6, 1.4)),
                }
            )
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

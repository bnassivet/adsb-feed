"""Check finished trajectories against the performance envelope that produced them.

Two jobs:

* **Retry signal.** The LangGraph ``validate`` node feeds these violations back
  into ``plan_route`` so a route that came out unflyable gets another attempt.
* **Regression net.** ``trajectory.py`` is supposed to make violations
  structurally impossible (arcs sized from the turn rate, altitude clamped to
  the climb rate). The tests assert the generator's own output validates clean,
  which is what keeps that guarantee honest as the generator evolves.

Tolerances are deliberately a little looser than the generator's own limits:
waypoints are sampled on a discrete time grid, so exact-boundary cases would
otherwise flap.
"""

from __future__ import annotations

from .kinematics import PROFILES, KinematicProfile
from .models import SimulatedAircraftTrajectory, TrajectoryResponse, Violation

RATE_TOLERANCE = 1.25
"""Multiplier applied to profile limits before flagging — absorbs sampling error."""


def _angular_diff(a: float, b: float) -> float:
    """Smallest absolute difference between two headings, accounting for wrap."""
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _speed_envelope(profile: KinematicProfile) -> tuple[float, float]:
    """Widest speed range the aircraft could legitimately be flying at."""
    floor = min(
        profile.approach_speed_kts[0],
        profile.climb_speed_kts[0],
        profile.cruise_speed_kts[0],
        profile.descent_speed_kts[0],
    )
    ceiling = max(
        profile.cruise_speed_kts[1],
        profile.climb_speed_kts[1],
        profile.descent_speed_kts[1],
    )
    return floor, ceiling


def validate_trajectory(
    trajectory: SimulatedAircraftTrajectory, profile: KinematicProfile
) -> list[Violation]:
    """Return every plausibility breach in ``trajectory`` (empty when clean)."""
    violations: list[Violation] = []
    wps = trajectory.waypoints
    if len(wps) < 2:
        return violations

    speed_floor, speed_ceiling = _speed_envelope(profile)

    for i, wp in enumerate(wps):
        if wp.alt_ft < 0:
            violations.append(
                Violation(
                    kind="altitude",
                    waypoint_index=i,
                    detail=f"altitude {wp.alt_ft:.0f} ft is below ground",
                )
            )
        if not (speed_floor / RATE_TOLERANCE <= wp.speed_kts <= speed_ceiling * RATE_TOLERANCE):
            violations.append(
                Violation(
                    kind="speed_band",
                    waypoint_index=i,
                    detail=(
                        f"speed {wp.speed_kts:.0f} kts outside "
                        f"{speed_floor:.0f}-{speed_ceiling:.0f} kts envelope"
                    ),
                )
            )

    for i in range(1, len(wps)):
        prev, cur = wps[i - 1], wps[i]
        dt = cur.t_offset_s - prev.t_offset_s

        if dt <= 0:
            violations.append(
                Violation(
                    kind="time_order",
                    waypoint_index=i,
                    detail=f"t_offset_s went from {prev.t_offset_s} to {cur.t_offset_s}",
                )
            )
            continue

        turn_dps = _angular_diff(cur.heading_deg, prev.heading_deg) / dt
        if turn_dps > profile.max_turn_rate_dps * RATE_TOLERANCE:
            violations.append(
                Violation(
                    kind="turn_rate",
                    waypoint_index=i,
                    detail=(
                        f"turned {turn_dps:.1f} deg/s, limit {profile.max_turn_rate_dps:.1f} deg/s"
                    ),
                )
            )

        fpm = (cur.alt_ft - prev.alt_ft) / dt * 60.0
        if fpm > profile.climb_rate_fpm[1] * RATE_TOLERANCE:
            violations.append(
                Violation(
                    kind="climb_rate",
                    waypoint_index=i,
                    detail=f"climbed {fpm:.0f} fpm, limit {profile.climb_rate_fpm[1]:.0f} fpm",
                )
            )
        elif -fpm > profile.descent_rate_fpm[1] * RATE_TOLERANCE:
            violations.append(
                Violation(
                    kind="descent_rate",
                    waypoint_index=i,
                    detail=(
                        f"descended {-fpm:.0f} fpm, limit {profile.descent_rate_fpm[1]:.0f} fpm"
                    ),
                )
            )

    return violations


def validate_response(response: TrajectoryResponse) -> list[Violation]:
    """Validate every aircraft in a response against its own category profile."""
    violations: list[Violation] = []
    for aircraft in response.aircraft:
        violations.extend(validate_trajectory(aircraft, PROFILES[aircraft.category]))
    return violations


def describe_violations(violations: list[Violation], limit: int = 5) -> str:
    """Short corrective summary for the retry prompt / caller-facing message."""
    if not violations:
        return "No plausibility issues."
    head = violations[:limit]
    lines = [f"- {v.kind} at waypoint {v.waypoint_index}: {v.detail}" for v in head]
    if len(violations) > limit:
        lines.append(f"- ...and {len(violations) - limit} more")
    return "\n".join(lines)


__all__ = ["describe_violations", "validate_response", "validate_trajectory"]

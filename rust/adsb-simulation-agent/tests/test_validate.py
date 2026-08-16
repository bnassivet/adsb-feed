"""Plausibility checking — the gate that drives the graph's retry edge.

These tests deliberately build *bad* trajectories by hand: the generator should
never produce them, but the validator is what proves that claim, and it must
also catch regressions if the generator changes.
"""

from __future__ import annotations

import pytest

from adsb_simulation_agent.kinematics import PROFILES
from adsb_simulation_agent.models import (
    AircraftCategory,
    FlightPhase,
    RoutePattern,
    RoutePlan,
    SimulatedAircraftTrajectory,
    TrajectoryRequest,
    Waypoint,
)
from adsb_simulation_agent.trajectory import generate_trajectory
from adsb_simulation_agent.validate import validate_response, validate_trajectory

ALL_COMBOS = [(p, c) for p in RoutePattern for c in AircraftCategory]


def _wp(**kw) -> Waypoint:
    params = {
        "lat": 45.5,
        "lng": -73.6,
        "alt_ft": 3000.0,
        "speed_kts": 120.0,
        "heading_deg": 0.0,
        "phase": FlightPhase.CRUISE,
        "t_offset_s": 0.0,
    }
    params.update(kw)
    return Waypoint(**params)


def _traj(waypoints: list[Waypoint], category=AircraftCategory.GA):
    return SimulatedAircraftTrajectory(
        hex_ident="SIM-TEST01",
        callsign="TEST01",
        category=category,
        waypoints=waypoints,
    )


class TestGeneratedTrajectoriesAreClean:
    """The whole point: what the generator emits must pass its own validator."""

    @pytest.mark.parametrize("pattern,category", ALL_COMBOS)
    def test_no_violations_for_any_combination(self, pattern, category):
        resp = generate_trajectory(
            TrajectoryRequest(
                origin_lat=45.5,
                origin_lng=-73.6,
                category=category,
                seed=7,
                plan=RoutePlan(pattern=pattern, category=category, radius_nm=6.0, turn_count=2),
            )
        )
        assert validate_response(resp) == []

    @pytest.mark.parametrize("seed", range(8))
    def test_random_default_plans_are_clean(self, seed):
        resp = generate_trajectory(
            TrajectoryRequest(
                origin_lat=45.5,
                origin_lng=-73.6,
                category=AircraftCategory.GA,
                count=3,
                seed=seed,
            )
        )
        assert validate_response(resp) == []


class TestTurnRate:
    def test_flags_an_impossible_turn(self):
        profile = PROFILES[AircraftCategory.AIRLINER]
        # 90 degrees in 2 seconds is 45 deg/s — far beyond an airliner's 3.
        traj = _traj(
            [
                _wp(t_offset_s=0.0, heading_deg=0.0),
                _wp(t_offset_s=2.0, heading_deg=90.0),
            ],
            AircraftCategory.AIRLINER,
        )
        violations = validate_trajectory(traj, profile)
        assert any(v.kind == "turn_rate" for v in violations)

    def test_accepts_a_turn_within_limits(self):
        profile = PROFILES[AircraftCategory.AIRLINER]
        # 6 degrees in 10 s = 0.6 deg/s, well inside 3.
        traj = _traj(
            [
                _wp(t_offset_s=0.0, heading_deg=0.0),
                _wp(t_offset_s=10.0, heading_deg=6.0),
            ],
            AircraftCategory.AIRLINER,
        )
        assert not any(v.kind == "turn_rate" for v in validate_trajectory(traj, profile))

    def test_handles_heading_wraparound(self):
        """359 -> 1 degrees is a 2 degree turn, not 358."""
        profile = PROFILES[AircraftCategory.AIRLINER]
        traj = _traj(
            [
                _wp(t_offset_s=0.0, heading_deg=359.0),
                _wp(t_offset_s=10.0, heading_deg=1.0),
            ],
            AircraftCategory.AIRLINER,
        )
        assert not any(v.kind == "turn_rate" for v in validate_trajectory(traj, profile))


class TestVerticalRate:
    def test_flags_an_impossible_climb(self):
        profile = PROFILES[AircraftCategory.GA]
        # 5000 ft in 10 s = 30,000 fpm.
        traj = _traj([_wp(t_offset_s=0.0, alt_ft=1000.0), _wp(t_offset_s=10.0, alt_ft=6000.0)])
        assert any(v.kind == "climb_rate" for v in validate_trajectory(traj, profile))

    def test_flags_an_impossible_descent(self):
        profile = PROFILES[AircraftCategory.GA]
        traj = _traj([_wp(t_offset_s=0.0, alt_ft=6000.0), _wp(t_offset_s=10.0, alt_ft=1000.0)])
        assert any(v.kind == "descent_rate" for v in validate_trajectory(traj, profile))

    def test_accepts_a_normal_climb(self):
        profile = PROFILES[AircraftCategory.GA]
        # 100 ft in 10 s = 600 fpm, inside the GA 900 fpm ceiling.
        traj = _traj([_wp(t_offset_s=0.0, alt_ft=1000.0), _wp(t_offset_s=10.0, alt_ft=1100.0)])
        violations = validate_trajectory(traj, profile)
        assert not any(v.kind in {"climb_rate", "descent_rate"} for v in violations)


class TestSpeedAndAltitude:
    def test_flags_a_speed_outside_the_envelope(self):
        profile = PROFILES[AircraftCategory.GA]
        traj = _traj([_wp(speed_kts=600.0), _wp(t_offset_s=10.0, speed_kts=600.0)])
        assert any(v.kind == "speed_band" for v in validate_trajectory(traj, profile))

    def test_flags_subterranean_altitude(self):
        profile = PROFILES[AircraftCategory.GA]
        traj = _traj([_wp(alt_ft=-100.0), _wp(t_offset_s=10.0, alt_ft=-50.0)])
        assert any(v.kind == "altitude" for v in validate_trajectory(traj, profile))

    def test_flags_non_monotonic_time(self):
        profile = PROFILES[AircraftCategory.GA]
        traj = _traj([_wp(t_offset_s=10.0), _wp(t_offset_s=5.0)])
        assert any(v.kind == "time_order" for v in validate_trajectory(traj, profile))


class TestReporting:
    def test_violations_carry_a_waypoint_index(self):
        profile = PROFILES[AircraftCategory.GA]
        traj = _traj(
            [
                _wp(t_offset_s=0.0, alt_ft=1000.0),
                _wp(t_offset_s=10.0, alt_ft=1050.0),
                _wp(t_offset_s=20.0, alt_ft=9000.0),  # the bad one
            ]
        )
        violations = validate_trajectory(traj, profile)
        assert violations
        assert violations[0].waypoint_index == 2

    def test_detail_mentions_the_numbers(self):
        profile = PROFILES[AircraftCategory.GA]
        traj = _traj([_wp(speed_kts=600.0), _wp(t_offset_s=10.0, speed_kts=600.0)])
        v = next(v for v in validate_trajectory(traj, profile) if v.kind == "speed_band")
        assert "600" in v.detail

    def test_short_trajectories_are_trivially_valid(self):
        profile = PROFILES[AircraftCategory.GA]
        assert validate_trajectory(_traj([]), profile) == []
        assert validate_trajectory(_traj([_wp()]), profile) == []

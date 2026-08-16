"""Anchor track + performance envelope -> timed, physically plausible waypoints.

This is the heart of DC3. The assertions here are the actual definition of
"follows basic flight dynamics rules".
"""

from __future__ import annotations

from itertools import pairwise

import pytest

from adsb_simulation_agent.kinematics import PROFILES, bearing_deg, great_circle_nm
from adsb_simulation_agent.models import (
    AircraftCategory,
    FlightPhase,
    RoutePattern,
    RoutePlan,
    TrajectoryRequest,
)
from adsb_simulation_agent.trajectory import generate_trajectory, round_corners

ORIGIN_LAT, ORIGIN_LNG = 45.5, -73.6


def angular_diff(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _request(category=AircraftCategory.GA, **kw) -> TrajectoryRequest:
    params = {
        "origin_lat": ORIGIN_LAT,
        "origin_lng": ORIGIN_LNG,
        "category": category,
        "seed": 1234,
    }
    params.update(kw)
    return TrajectoryRequest(**params)


def _plan(pattern: RoutePattern, category: AircraftCategory, **kw) -> RoutePlan:
    params = {
        "pattern": pattern,
        "category": category,
        "radius_nm": 6.0,
        "bearing_deg": 30.0,
        "turn_count": 2,
    }
    params.update(kw)
    return RoutePlan(**params)


ALL_COMBOS = [(pattern, category) for pattern in RoutePattern for category in AircraftCategory]


class TestCornerRounding:
    def test_a_sharp_corner_gains_intermediate_points(self):
        """A 90-degree kink is unflyable; rounding must insert an arc."""
        a = (45.40, -73.60)
        b = (45.50, -73.60)  # due north leg
        c = (45.50, -73.40)  # then due east — a 90 degree corner
        rounded = round_corners([a, b, c], turn_radius_nm=1.0)
        assert len(rounded) > 3

    def test_a_straight_line_is_left_alone(self):
        straight = [(45.40, -73.6), (45.50, -73.6), (45.60, -73.6)]
        rounded = round_corners(straight, turn_radius_nm=1.0)
        assert len(rounded) == len(straight)

    def test_rounding_removes_the_sharp_heading_change(self):
        corner = [(45.40, -73.60), (45.50, -73.60), (45.50, -73.40)]
        rounded = round_corners(corner, turn_radius_nm=1.0)
        deltas = [
            angular_diff(bearing_deg(*p, *q), bearing_deg(*q, *r))
            for p, q, r in zip(rounded, rounded[1:], rounded[2:])
        ]
        # The original 90-degree break is now spread across several small turns.
        assert max(deltas) < 60.0

    def test_endpoints_are_preserved(self):
        pts = [(45.40, -73.60), (45.50, -73.60), (45.50, -73.40)]
        rounded = round_corners(pts, turn_radius_nm=1.0)
        assert rounded[0] == pts[0]
        assert rounded[-1] == pts[-1]

    def test_degenerate_input_is_returned_unchanged(self):
        assert round_corners([], 1.0) == []
        assert round_corners([(45.5, -73.6)], 1.0) == [(45.5, -73.6)]

    def test_radius_is_clamped_to_fit_short_legs(self):
        """A turn radius larger than the legs would overshoot the corner; the
        implementation must shrink it rather than produce a scrambled track."""
        tiny = [(45.500, -73.600), (45.502, -73.600), (45.502, -73.598)]
        rounded = round_corners(tiny, turn_radius_nm=50.0)
        for lat, lng in rounded:
            assert great_circle_nm(45.5, -73.6, lat, lng) < 5.0


class TestTrajectoryContract:
    @pytest.mark.parametrize("pattern,category", ALL_COMBOS)
    def test_produces_waypoints_for_every_combination(self, pattern, category):
        resp = generate_trajectory(_request(category, plan=_plan(pattern, category)))
        assert len(resp.aircraft) == 1
        assert len(resp.aircraft[0].waypoints) >= 2

    @pytest.mark.parametrize("pattern,category", ALL_COMBOS)
    def test_time_advances_strictly(self, pattern, category):
        wps = (
            generate_trajectory(_request(category, plan=_plan(pattern, category)))
            .aircraft[0]
            .waypoints
        )
        assert wps[0].t_offset_s == 0.0
        for a, b in pairwise(wps):
            assert b.t_offset_s > a.t_offset_s

    @pytest.mark.parametrize("pattern,category", ALL_COMBOS)
    def test_speeds_stay_inside_the_category_envelope(self, pattern, category):
        profile = PROFILES[category]
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
        wps = (
            generate_trajectory(_request(category, plan=_plan(pattern, category)))
            .aircraft[0]
            .waypoints
        )
        for wp in wps:
            assert floor <= wp.speed_kts <= ceiling

    @pytest.mark.parametrize("pattern,category", ALL_COMBOS)
    def test_altitude_never_goes_underground(self, pattern, category):
        wps = (
            generate_trajectory(_request(category, plan=_plan(pattern, category)))
            .aircraft[0]
            .waypoints
        )
        for wp in wps:
            assert wp.alt_ft >= 0

    @pytest.mark.parametrize("pattern,category", ALL_COMBOS)
    def test_headings_are_normalized(self, pattern, category):
        wps = (
            generate_trajectory(_request(category, plan=_plan(pattern, category)))
            .aircraft[0]
            .waypoints
        )
        for wp in wps:
            assert 0 <= wp.heading_deg < 360


class TestFlightDynamics:
    """DC3 proper — the constraints that make a track look like real flight."""

    @pytest.mark.parametrize("pattern,category", ALL_COMBOS)
    def test_turn_rate_never_exceeds_the_category_limit(self, pattern, category):
        limit = PROFILES[category].max_turn_rate_dps
        wps = (
            generate_trajectory(_request(category, plan=_plan(pattern, category)))
            .aircraft[0]
            .waypoints
        )
        for a, b in pairwise(wps):
            dt = b.t_offset_s - a.t_offset_s
            change = angular_diff(b.heading_deg, a.heading_deg)
            # 20% tolerance absorbs great-circle convergence over long legs.
            assert change <= limit * dt * 1.2 + 1.0, (
                f"{category.value}/{pattern.value}: turned {change:.1f} deg in "
                f"{dt:.1f}s (limit {limit} deg/s)"
            )

    @pytest.mark.parametrize("pattern,category", ALL_COMBOS)
    def test_vertical_rate_never_exceeds_the_category_limit(self, pattern, category):
        profile = PROFILES[category]
        limit_fpm = max(profile.climb_rate_fpm[1], profile.descent_rate_fpm[1])
        wps = (
            generate_trajectory(_request(category, plan=_plan(pattern, category)))
            .aircraft[0]
            .waypoints
        )
        for a, b in pairwise(wps):
            dt = b.t_offset_s - a.t_offset_s
            fpm = abs(b.alt_ft - a.alt_ft) / dt * 60.0
            assert fpm <= limit_fpm * 1.2 + 1.0

    @pytest.mark.parametrize("pattern,category", ALL_COMBOS)
    def test_ground_speed_matches_the_distance_actually_covered(self, pattern, category):
        """Timing must be derived from the geometry, not decorative. This is the
        bug in the old hand-authored demo flights: ground_speed was a display
        field with no relationship to how fast the icon actually moved."""
        wps = (
            generate_trajectory(_request(category, plan=_plan(pattern, category)))
            .aircraft[0]
            .waypoints
        )
        for a, b in pairwise(wps):
            dt_h = (b.t_offset_s - a.t_offset_s) / 3600.0
            actual_kts = great_circle_nm(a.lat, a.lng, b.lat, b.lng) / dt_h
            assert actual_kts == pytest.approx(a.speed_kts, rel=0.25)

    def test_airliner_transit_climbs_then_cruises_then_descends(self):
        wps = (
            generate_trajectory(
                _request(
                    AircraftCategory.AIRLINER,
                    plan=_plan(RoutePattern.TRANSIT, AircraftCategory.AIRLINER),
                )
            )
            .aircraft[0]
            .waypoints
        )
        phases = [wp.phase for wp in wps]
        assert phases[0] == FlightPhase.CLIMB
        assert FlightPhase.CRUISE in phases
        assert phases[-1] == FlightPhase.DESCENT
        # And the altitude actually follows the phases.
        climb_alts = [w.alt_ft for w in wps if w.phase == FlightPhase.CLIMB]
        assert climb_alts[-1] > climb_alts[0]

    def test_approach_descends_to_near_ground(self):
        wps = (
            generate_trajectory(
                _request(
                    AircraftCategory.GA,
                    plan=_plan(RoutePattern.APPROACH, AircraftCategory.GA),
                )
            )
            .aircraft[0]
            .waypoints
        )
        assert wps[-1].alt_ft < wps[0].alt_ft
        assert wps[-1].phase == FlightPhase.APPROACH
        assert wps[-1].alt_ft < 1500

    def test_helicopter_orbit_loiters_at_low_level(self):
        wps = (
            generate_trajectory(
                _request(
                    AircraftCategory.HELICOPTER,
                    plan=_plan(RoutePattern.ORBIT, AircraftCategory.HELICOPTER),
                )
            )
            .aircraft[0]
            .waypoints
        )
        assert any(w.phase == FlightPhase.LOITER for w in wps)
        ceiling = PROFILES[AircraftCategory.HELICOPTER].cruise_alt_ft[1]
        assert max(w.alt_ft for w in wps) <= ceiling

    def test_fighter_maneuver_is_tagged_as_maneuvering(self):
        wps = (
            generate_trajectory(
                _request(
                    AircraftCategory.FIGHTER,
                    plan=_plan(RoutePattern.MANEUVER, AircraftCategory.FIGHTER),
                )
            )
            .aircraft[0]
            .waypoints
        )
        assert any(w.phase == FlightPhase.MANEUVER for w in wps)

    def test_requested_cruise_altitude_is_honoured(self):
        resp = generate_trajectory(
            _request(
                AircraftCategory.GA,
                cruise_altitude_ft=4500,
                plan=_plan(RoutePattern.TRANSIT, AircraftCategory.GA),
            )
        )
        assert max(w.alt_ft for w in resp.aircraft[0].waypoints) == pytest.approx(4500, rel=0.1)


class TestMultipleAircraft:
    def test_count_produces_that_many_aircraft(self):
        resp = generate_trajectory(_request(count=4))
        assert len(resp.aircraft) == 4

    def test_identifiers_are_unique(self):
        resp = generate_trajectory(_request(count=6))
        assert len({a.hex_ident for a in resp.aircraft}) == 6
        assert len({a.callsign for a in resp.aircraft}) == 6

    def test_tracks_are_not_all_identical(self):
        """Six aircraft stacked on one path would look obviously fake."""
        resp = generate_trajectory(_request(count=4))
        starts = {
            (round(a.waypoints[0].lat, 4), round(a.waypoints[0].lng, 4)) for a in resp.aircraft
        }
        assert len(starts) > 1

    def test_callsign_prefix_is_applied(self):
        resp = generate_trajectory(_request(count=3, callsign_prefix="DEMO"))
        assert all(a.callsign.startswith("DEMO") for a in resp.aircraft)

    def test_category_is_propagated(self):
        resp = generate_trajectory(_request(AircraftCategory.FIGHTER, count=2))
        assert all(a.category == AircraftCategory.FIGHTER for a in resp.aircraft)


class TestDeterminism:
    def test_same_seed_gives_the_same_trajectory(self):
        a = generate_trajectory(_request(seed=99, count=2))
        b = generate_trajectory(_request(seed=99, count=2))
        assert a.model_dump() == b.model_dump()

    def test_different_seeds_give_different_trajectories(self):
        a = generate_trajectory(_request(seed=1))
        b = generate_trajectory(_request(seed=2))
        assert a.model_dump() != b.model_dump()

    def test_falls_back_to_a_default_plan_without_one(self):
        resp = generate_trajectory(_request(plan=None, route_hint=None))
        assert resp.aircraft[0].waypoints


class TestSummary:
    def test_summary_is_compact_and_informative(self):
        """The chat model must never receive the full waypoint payload."""
        resp = generate_trajectory(_request(count=3))
        summary = resp.summary()
        assert len(summary) < 200
        assert "3 aircraft" in summary
        assert "waypoints" in summary

    def test_empty_response_summarizes_cleanly(self):
        from adsb_simulation_agent.models import TrajectoryResponse

        assert "No aircraft" in TrajectoryResponse(aircraft=[]).summary()

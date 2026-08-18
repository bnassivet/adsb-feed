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
    RouteLeg,
    RoutePattern,
    RoutePlan,
    SpeedBias,
    TrajectoryRequest,
)
from adsb_simulation_agent.trajectory import generate_trajectory, round_corners
from adsb_simulation_agent.validate import validate_response

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


# ---------------------------------------------------------------------------
# Multi-leg routes
# ---------------------------------------------------------------------------

INBOUND = (46.49365, -1.79214)
ILE_DYEU = (46.69154, -2.35931)
OUTBOUND = (46.71161, -1.92810)


def _leg(pattern: RoutePattern, anchor=None, **kw) -> RouteLeg:
    params = {"pattern": pattern, "radius_nm": 6.0, "bearing_deg": 0.0, "turn_count": 1}
    params.update(kw)
    if anchor is not None:
        params["anchor_lat"], params["anchor_lng"] = anchor
    return RouteLeg(**params)


def _fighter_scenario() -> RoutePlan:
    """The worked example: in from a point, manoeuver over another, out to a third."""
    return RoutePlan(
        category=AircraftCategory.FIGHTER,
        legs=[
            _leg(RoutePattern.TRANSIT, anchor=ILE_DYEU, altitude_ft=10000.0),
            _leg(
                RoutePattern.MANEUVER,
                anchor=ILE_DYEU,
                radius_nm=5.0,
                turn_count=2,
                altitude_min_ft=1000.0,
                altitude_max_ft=3000.0,
                speed_bias=SpeedBias.FAST,
            ),
            _leg(RoutePattern.TRANSIT, anchor=OUTBOUND),
        ],
    )


def _multi_leg_waypoints(plan: RoutePlan, origin=INBOUND):
    request = TrajectoryRequest(
        origin_lat=origin[0],
        origin_lng=origin[1],
        category=plan.category,
        count=1,
        plan=plan,
        seed=99,
    )
    response = generate_trajectory(request)
    assert response.aircraft, "no aircraft generated"
    return response.aircraft[0].waypoints


class TestMultiLegStructure:
    def test_every_leg_is_represented(self):
        wps = _multi_leg_waypoints(_fighter_scenario())
        assert sorted({wp.leg_index for wp in wps}) == [0, 1, 2]

    def test_leg_indices_never_go_backwards(self):
        """Legs are flown in order, so the index is monotonically non-decreasing."""
        wps = _multi_leg_waypoints(_fighter_scenario())
        indices = [wp.leg_index for wp in wps]
        assert indices == sorted(indices)

    def test_time_stays_monotonic_across_leg_boundaries(self):
        wps = _multi_leg_waypoints(_fighter_scenario())
        assert all(b.t_offset_s > a.t_offset_s for a, b in pairwise(wps))

    def test_the_track_is_continuous_across_leg_boundaries(self):
        """No teleporting between legs — the gap stays within one sampling step."""
        wps = _multi_leg_waypoints(_fighter_scenario())
        gaps = [great_circle_nm(a.lat, a.lng, b.lat, b.lng) for a, b in pairwise(wps)]
        assert max(gaps) < 5.0, f"largest gap {max(gaps):.1f} NM looks like a jump"

    def test_the_route_starts_at_the_origin_and_ends_at_the_last_anchor(self):
        wps = _multi_leg_waypoints(_fighter_scenario())
        assert great_circle_nm(*INBOUND, wps[0].lat, wps[0].lng) < 1.0
        assert great_circle_nm(*OUTBOUND, wps[-1].lat, wps[-1].lng) < 1.0

    def test_the_middle_leg_happens_over_its_anchor(self):
        wps = _multi_leg_waypoints(_fighter_scenario())
        maneuver = [wp for wp in wps if wp.leg_index == 1]
        assert maneuver
        centre_gap = min(great_circle_nm(*ILE_DYEU, wp.lat, wp.lng) for wp in maneuver)
        assert centre_gap < 2.0


class TestMultiLegDynamics:
    """A multi-leg route is still bound by the performance envelope."""

    def test_turn_rate_never_exceeds_the_limit(self):
        profile = PROFILES[AircraftCategory.FIGHTER]
        wps = _multi_leg_waypoints(_fighter_scenario())
        for a, b in pairwise(wps):
            dt = b.t_offset_s - a.t_offset_s
            rate = angular_diff(b.heading_deg, a.heading_deg) / dt
            assert rate <= profile.max_turn_rate_dps * 1.25, f"turned {rate:.1f} deg/s"

    def test_vertical_rate_never_exceeds_the_limit(self):
        profile = PROFILES[AircraftCategory.FIGHTER]
        wps = _multi_leg_waypoints(_fighter_scenario())
        for a, b in pairwise(wps):
            dt_min = (b.t_offset_s - a.t_offset_s) / 60.0
            fpm = (b.alt_ft - a.alt_ft) / dt_min
            assert fpm <= profile.climb_rate_fpm[1] * 1.25
            assert -fpm <= profile.descent_rate_fpm[1] * 1.25

    def test_generated_multi_leg_output_validates_clean(self):
        request = TrajectoryRequest(
            origin_lat=INBOUND[0],
            origin_lng=INBOUND[1],
            category=AircraftCategory.FIGHTER,
            count=3,
            plan=_fighter_scenario(),
            seed=7,
        )
        assert validate_response(generate_trajectory(request)) == []


class TestAltitudeOscillation:
    def test_the_leg_cycles_between_its_bounds(self):
        wps = _multi_leg_waypoints(_fighter_scenario())
        alts = [wp.alt_ft for wp in wps if wp.leg_index == 1]
        assert alts
        # It genuinely goes up *and* down, rather than holding a mid value.
        assert max(alts) - min(alts) > 800.0

    def test_it_settles_within_the_requested_band(self):
        """The aircraft arrives at 10 000 ft, so it must *descend* into the band.

        That descent happens at the profile's rate on the first part of the leg
        — which is correct, not a band violation — so the band assertion applies
        once the aircraft has had time to get down.
        """
        wps = _multi_leg_waypoints(_fighter_scenario())
        alts = [wp.alt_ft for wp in wps if wp.leg_index == 1]
        assert alts
        settled = alts[len(alts) // 2 :]
        assert min(settled) >= 1000.0 - 200.0
        assert max(settled) <= 3000.0 + 200.0

    def test_it_descends_out_of_the_transit_altitude(self):
        wps = _multi_leg_waypoints(_fighter_scenario())
        alts = [wp.alt_ft for wp in wps if wp.leg_index == 1]
        assert min(alts) < 3000.0 + 200.0, "never came down to the requested band"

    def test_a_leg_without_a_band_holds_its_altitude(self):
        plan = RoutePlan(
            category=AircraftCategory.GA,
            legs=[_leg(RoutePattern.ORBIT, radius_nm=4.0, turn_count=2, altitude_ft=3000.0)],
        )
        alts = [wp.alt_ft for wp in _multi_leg_waypoints(plan)]
        assert max(alts) - min(alts) < 500.0


class TestSpeedBias:
    def test_fast_flies_quicker_than_normal(self):
        def mean_speed(bias: SpeedBias) -> float:
            plan = RoutePlan(
                category=AircraftCategory.GA,
                legs=[_leg(RoutePattern.TRANSIT, radius_nm=10.0, speed_bias=bias)],
            )
            wps = _multi_leg_waypoints(plan)
            return sum(wp.speed_kts for wp in wps) / len(wps)

        assert mean_speed(SpeedBias.FAST) > mean_speed(SpeedBias.NORMAL)
        assert mean_speed(SpeedBias.SLOW) < mean_speed(SpeedBias.NORMAL)

    def test_a_fast_leg_stays_inside_the_envelope(self):
        plan = RoutePlan(
            category=AircraftCategory.FIGHTER,
            legs=[_leg(RoutePattern.TRANSIT, radius_nm=20.0, speed_bias=SpeedBias.FAST)],
        )
        request = TrajectoryRequest(
            origin_lat=INBOUND[0],
            origin_lng=INBOUND[1],
            category=AircraftCategory.FIGHTER,
            plan=plan,
            seed=3,
        )
        assert validate_response(generate_trajectory(request)) == []


class TestAnchorsSurviveJitter:
    """Extra aircraft must not be scattered off the user's stated coordinates."""

    def test_every_aircraft_reaches_the_final_anchor(self):
        request = TrajectoryRequest(
            origin_lat=INBOUND[0],
            origin_lng=INBOUND[1],
            category=AircraftCategory.FIGHTER,
            count=3,
            plan=_fighter_scenario(),
            seed=11,
        )
        response = generate_trajectory(request)
        assert len(response.aircraft) == 3
        for aircraft in response.aircraft:
            last = aircraft.waypoints[-1]
            assert great_circle_nm(*OUTBOUND, last.lat, last.lng) < 3.0

    def test_the_aircraft_fly_separated_tracks(self):
        """They share the named points — they must not share the whole track.

        The start is deliberately *not* the discriminator: all three were asked
        to come from the same coordinate, so they legitimately begin together.
        """
        request = TrajectoryRequest(
            origin_lat=INBOUND[0],
            origin_lng=INBOUND[1],
            category=AircraftCategory.FIGHTER,
            count=3,
            plan=_fighter_scenario(),
            seed=11,
        )
        aircraft = generate_trajectory(request).aircraft
        working = [
            [(round(wp.lat, 4), round(wp.lng, 4)) for wp in a.waypoints if wp.leg_index == 1]
            for a in aircraft
        ]
        assert all(working), "an aircraft never reached the working area"
        assert len({tuple(track) for track in working}) == 3, "formation members are stacked"


class TestScenarioEntryAltitude:
    """An aircraft that arrives "at 10000 ft" is already there when we meet it."""

    def test_a_first_leg_with_a_stated_altitude_starts_level(self):
        wps = _multi_leg_waypoints(_fighter_scenario())
        first = [wp for wp in wps if wp.leg_index == 0]
        assert first[0].alt_ft == pytest.approx(10000.0, rel=0.05)
        assert all(wp.phase == FlightPhase.CRUISE for wp in first)

    def test_a_first_leg_without_a_stated_altitude_still_climbs_out(self):
        plan = RoutePlan(
            category=AircraftCategory.GA,
            legs=[
                _leg(RoutePattern.TRANSIT, radius_nm=10.0),
                _leg(RoutePattern.ORBIT, radius_nm=4.0),
            ],
        )
        first = [wp for wp in _multi_leg_waypoints(plan) if wp.leg_index == 0]
        assert any(wp.phase == FlightPhase.CLIMB for wp in first)

    def test_a_single_leg_plan_still_climbs_out(self):
        """Regression guard: this behaviour is only for multi-leg entries."""
        plan = RoutePlan(
            category=AircraftCategory.GA,
            legs=[_leg(RoutePattern.TRANSIT, radius_nm=10.0, altitude_ft=6000.0)],
        )
        wps = _multi_leg_waypoints(plan)
        assert any(wp.phase == FlightPhase.CLIMB for wp in wps)


class TestLegJoinRounding:
    """Regression: the join between two legs must actually get rounded.

    Each leg starts where the previous ended, so the join point appears in both
    lists. Left duplicated, the corner's inbound leg has zero length, its
    tangent clamps to zero, and the corner is skipped entirely — emitting a
    sharp, unflyable turn exactly at every leg boundary.
    """

    def test_the_turn_between_two_opposed_legs_is_flyable(self):
        limit = PROFILES[AircraftCategory.FIGHTER].max_turn_rate_dps
        # Out to a point, then straight back the way it came: the sharpest
        # possible join, a full reversal.
        plan = RoutePlan(
            category=AircraftCategory.FIGHTER,
            legs=[
                _leg(RoutePattern.TRANSIT, anchor=ILE_DYEU),
                _leg(RoutePattern.TRANSIT, anchor=INBOUND),
            ],
        )
        wps = _multi_leg_waypoints(plan)
        for a, b in pairwise(wps):
            dt = b.t_offset_s - a.t_offset_s
            rate = angular_diff(b.heading_deg, a.heading_deg) / dt
            assert rate <= limit * 1.25, f"reversal turned at {rate:.1f} deg/s"

    def test_no_duplicate_positions_at_a_leg_boundary(self):
        wps = _multi_leg_waypoints(_fighter_scenario())
        for a, b in pairwise(wps):
            assert great_circle_nm(a.lat, a.lng, b.lat, b.lng) > 0.0

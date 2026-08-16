"""Deterministic pattern synthesis: RoutePlan (intent) -> anchor ground track.

No LLM is involved at this layer. These tests pin the geometric contract that
``trajectory.py`` then hangs altitudes and speeds off.
"""

from __future__ import annotations

from itertools import pairwise

import pytest

from adsb_simulation_agent.geometry import build_anchors, default_plan_for
from adsb_simulation_agent.kinematics import bearing_deg, great_circle_nm
from adsb_simulation_agent.models import AircraftCategory, RoutePattern, RoutePlan

ORIGIN = (45.5, -73.6)


def angular_diff(a: float, b: float) -> float:
    """Smallest absolute difference between two headings, in degrees.

    Bearings wrap, so 359.9 and 0.1 are 0.2 degrees apart, not 359.8. Comparing
    them numerically is the classic way an angle assertion gets it wrong.
    """
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _plan(pattern: RoutePattern, **kw) -> RoutePlan:
    params = {
        "pattern": pattern,
        "category": AircraftCategory.GA,
        "radius_nm": 5.0,
        "bearing_deg": 0.0,
        "turn_count": 1,
    }
    params.update(kw)
    return RoutePlan(**params)


class TestCommonContract:
    @pytest.mark.parametrize("pattern", list(RoutePattern))
    def test_every_pattern_produces_a_usable_track(self, pattern):
        anchors = build_anchors(_plan(pattern), *ORIGIN)
        assert len(anchors) >= 2, "a track needs at least a start and an end"
        for lat, lng in anchors:
            assert -90 <= lat <= 90
            assert -180 <= lng <= 180

    @pytest.mark.parametrize("pattern", list(RoutePattern))
    def test_anchors_stay_within_a_sane_distance_of_origin(self, pattern):
        """Nothing should wander off the map — the desktop app shows a local view."""
        anchors = build_anchors(_plan(pattern, radius_nm=5.0), *ORIGIN)
        for lat, lng in anchors:
            assert great_circle_nm(*ORIGIN, lat, lng) <= 5.0 * 3.0

    @pytest.mark.parametrize("pattern", list(RoutePattern))
    def test_generation_is_deterministic(self, pattern):
        plan = _plan(pattern)
        assert build_anchors(plan, *ORIGIN) == build_anchors(plan, *ORIGIN)

    @pytest.mark.parametrize("pattern", list(RoutePattern))
    def test_consecutive_anchors_are_distinct(self, pattern):
        """Duplicate points would make heading undefined at that waypoint."""
        anchors = build_anchors(_plan(pattern), *ORIGIN)
        for a, b in pairwise(anchors):
            assert great_circle_nm(*a, *b) > 1e-6

    @pytest.mark.parametrize("pattern", list(RoutePattern))
    def test_radius_scales_the_pattern(self, pattern):
        small = build_anchors(_plan(pattern, radius_nm=2.0), *ORIGIN)
        large = build_anchors(_plan(pattern, radius_nm=8.0), *ORIGIN)
        spread_small = max(great_circle_nm(*ORIGIN, *p) for p in small)
        spread_large = max(great_circle_nm(*ORIGIN, *p) for p in large)
        assert spread_large > spread_small


class TestOrbit:
    def test_all_anchors_sit_on_the_requested_radius(self):
        anchors = build_anchors(_plan(RoutePattern.ORBIT, radius_nm=4.0), *ORIGIN)
        for lat, lng in anchors:
            assert great_circle_nm(*ORIGIN, lat, lng) == pytest.approx(4.0, rel=0.02)

    def test_track_closes_back_on_itself(self):
        anchors = build_anchors(_plan(RoutePattern.ORBIT), *ORIGIN)
        assert great_circle_nm(*anchors[0], *anchors[-1]) < 0.5

    def test_more_laps_produce_more_anchors(self):
        one = build_anchors(_plan(RoutePattern.ORBIT, turn_count=1), *ORIGIN)
        three = build_anchors(_plan(RoutePattern.ORBIT, turn_count=3), *ORIGIN)
        assert len(three) > len(one)

    def test_bearing_rotates_the_entry_point(self):
        north = build_anchors(_plan(RoutePattern.ORBIT, bearing_deg=0.0), *ORIGIN)
        east = build_anchors(_plan(RoutePattern.ORBIT, bearing_deg=90.0), *ORIGIN)
        assert angular_diff(bearing_deg(*ORIGIN, *north[0]), 0.0) < 1.0
        assert angular_diff(bearing_deg(*ORIGIN, *east[0]), 90.0) < 1.0


class TestTransit:
    def test_passes_across_the_origin(self):
        """A transit enters one side and leaves the other, so the midpoint of the
        track is near the origin."""
        anchors = build_anchors(_plan(RoutePattern.TRANSIT, radius_nm=6.0), *ORIGIN)
        start, end = anchors[0], anchors[-1]
        assert great_circle_nm(*ORIGIN, *start) == pytest.approx(6.0, rel=0.05)
        assert great_circle_nm(*ORIGIN, *end) == pytest.approx(6.0, rel=0.05)
        # Start and end are on opposite sides: their separation is the diameter.
        assert great_circle_nm(*start, *end) == pytest.approx(12.0, rel=0.05)

    def test_flies_along_the_requested_bearing(self):
        anchors = build_anchors(_plan(RoutePattern.TRANSIT, bearing_deg=90.0), *ORIGIN)
        assert bearing_deg(*anchors[0], *anchors[-1]) == pytest.approx(90.0, abs=1.0)

    def test_is_a_straight_line(self):
        """Every leg shares the overall bearing — no turns in a transit."""
        anchors = build_anchors(_plan(RoutePattern.TRANSIT, bearing_deg=45.0), *ORIGIN)
        for a, b in pairwise(anchors):
            assert bearing_deg(*a, *b) == pytest.approx(45.0, abs=1.0)


class TestRacetrack:
    def test_returns_close_to_where_it_started(self):
        anchors = build_anchors(_plan(RoutePattern.RACETRACK), *ORIGIN)
        assert great_circle_nm(*anchors[0], *anchors[-1]) < 1.0

    def test_has_two_opposing_legs(self):
        """The defining feature: the track reverses direction partway through."""
        anchors = build_anchors(_plan(RoutePattern.RACETRACK, bearing_deg=0.0), *ORIGIN)
        headings = [bearing_deg(*a, *b) for a, b in pairwise(anchors)]
        # Some leg must run roughly opposite to the first.
        first = headings[0]
        assert any(abs(((h - first + 540) % 360) - 180) < 30 for h in headings)

    def test_more_laps_produce_more_anchors(self):
        one = build_anchors(_plan(RoutePattern.RACETRACK, turn_count=1), *ORIGIN)
        two = build_anchors(_plan(RoutePattern.RACETRACK, turn_count=2), *ORIGIN)
        assert len(two) > len(one)


class TestApproach:
    def test_ends_at_the_origin(self):
        """An approach terminates at the field, which is the request origin."""
        anchors = build_anchors(_plan(RoutePattern.APPROACH, radius_nm=7.0), *ORIGIN)
        assert great_circle_nm(*ORIGIN, *anchors[-1]) < 0.5

    def test_starts_out_at_the_requested_distance(self):
        anchors = build_anchors(_plan(RoutePattern.APPROACH, radius_nm=7.0), *ORIGIN)
        assert great_circle_nm(*ORIGIN, *anchors[0]) == pytest.approx(7.0, rel=0.05)

    def test_is_a_straight_in_final(self):
        anchors = build_anchors(_plan(RoutePattern.APPROACH, bearing_deg=270.0), *ORIGIN)
        legs = [bearing_deg(*a, *b) for a, b in pairwise(anchors)]
        assert max(legs) - min(legs) < 2.0


class TestManeuver:
    def test_crosses_over_itself(self):
        """A figure-eight revisits its own centre — that's what distinguishes it
        from an orbit."""
        anchors = build_anchors(_plan(RoutePattern.MANEUVER, radius_nm=4.0), *ORIGIN)
        near_centre = [p for p in anchors if great_circle_nm(*ORIGIN, *p) < 1.0]
        assert len(near_centre) >= 2

    def test_reaches_both_sides_of_the_origin(self):
        anchors = build_anchors(_plan(RoutePattern.MANEUVER, bearing_deg=0.0), *ORIGIN)
        bearings = [bearing_deg(*ORIGIN, *p) for p in anchors if great_circle_nm(*ORIGIN, *p) > 1.0]
        assert any(b < 90 or b > 270 for b in bearings), "nothing north of origin"
        assert any(90 < b < 270 for b in bearings), "nothing south of origin"


class TestDefaultPlan:
    @pytest.mark.parametrize("category", list(AircraftCategory))
    def test_every_category_gets_a_sensible_default(self, category):
        plan = default_plan_for(category, seed=42)
        assert plan.category == category
        assert plan.radius_nm > 0
        assert build_anchors(plan, *ORIGIN)

    def test_is_reproducible_for_a_given_seed(self):
        a = default_plan_for(AircraftCategory.HELICOPTER, seed=7)
        b = default_plan_for(AircraftCategory.HELICOPTER, seed=7)
        assert a == b

    def test_different_seeds_vary_the_result(self):
        plans = {default_plan_for(AircraftCategory.GA, seed=s).model_dump_json() for s in range(20)}
        assert len(plans) > 1, "seeding has no effect — routes would all look identical"

    def test_helicopters_default_to_a_local_pattern(self):
        """Rotorcraft loiter; they don't fly airway transits at 30k ft."""
        plan = default_plan_for(AircraftCategory.HELICOPTER, seed=1)
        assert plan.pattern in {RoutePattern.ORBIT, RoutePattern.RACETRACK}
        assert plan.radius_nm <= 10

"""The intent schema, and the single-leg compatibility contract.

``RoutePlan`` became a *sequence* of legs, but every existing caller — the
desktop panel form, ``default_plan_for``, ``executor.parse_trajectory_request``
and most of this suite — constructs it with flat scalars. That flat form must
keep working and must mean "one leg", which is what these tests pin.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from adsb_simulation_agent.models import (
    AircraftCategory,
    RouteLeg,
    RoutePattern,
    RoutePlan,
    SpeedBias,
    Waypoint,
)


class TestFlatCompatibility:
    """Flat scalars normalize into a one-leg plan."""

    def test_flat_kwargs_produce_one_leg(self):
        plan = RoutePlan(
            pattern=RoutePattern.ORBIT,
            category=AircraftCategory.HELICOPTER,
            radius_nm=2.5,
            bearing_deg=90.0,
            altitude_ft=1500.0,
            turn_count=3,
        )
        assert len(plan.legs) == 1
        leg = plan.legs[0]
        assert leg.pattern == RoutePattern.ORBIT
        assert leg.radius_nm == 2.5
        assert leg.bearing_deg == 90.0
        assert leg.altitude_ft == 1500.0
        assert leg.turn_count == 3

    def test_scalar_properties_delegate_to_first_leg(self):
        plan = RoutePlan(
            pattern=RoutePattern.TRANSIT,
            category=AircraftCategory.GA,
            radius_nm=7.0,
            bearing_deg=180.0,
            turn_count=2,
        )
        assert plan.pattern == RoutePattern.TRANSIT
        assert plan.radius_nm == 7.0
        assert plan.bearing_deg == 180.0
        assert plan.turn_count == 2
        assert plan.altitude_ft is None

    def test_defaults_match_the_previous_schema(self):
        plan = RoutePlan(pattern=RoutePattern.ORBIT, category=AircraftCategory.GA)
        assert plan.radius_nm == 3.0
        assert plan.bearing_deg == 0.0
        assert plan.turn_count == 1
        assert plan.altitude_ft is None

    def test_flat_bounds_are_still_enforced(self):
        with pytest.raises(ValidationError):
            RoutePlan(pattern=RoutePattern.ORBIT, category=AircraftCategory.GA, radius_nm=0)
        with pytest.raises(ValidationError):
            RoutePlan(pattern=RoutePattern.ORBIT, category=AircraftCategory.GA, turn_count=99)


class TestMultiLeg:
    def test_legs_are_accepted_directly(self):
        plan = RoutePlan(
            category=AircraftCategory.FIGHTER,
            legs=[
                RouteLeg(pattern=RoutePattern.TRANSIT, radius_nm=10.0),
                RouteLeg(pattern=RoutePattern.MANEUVER, radius_nm=4.0),
                RouteLeg(pattern=RoutePattern.TRANSIT, radius_nm=8.0),
            ],
        )
        assert len(plan.legs) == 3
        # The scalar view still reports the *first* leg, so single-leg readers
        # degrade to the head of the route rather than breaking.
        assert plan.pattern == RoutePattern.TRANSIT
        assert plan.radius_nm == 10.0

    def test_legs_from_dicts(self):
        plan = RoutePlan(
            category=AircraftCategory.GA,
            legs=[{"pattern": "transit", "radius_nm": 6.0}, {"pattern": "orbit"}],
        )
        assert [leg.pattern for leg in plan.legs] == [RoutePattern.TRANSIT, RoutePattern.ORBIT]

    def test_at_least_one_leg_is_required(self):
        with pytest.raises(ValidationError):
            RoutePlan(category=AircraftCategory.GA, legs=[])

    def test_legs_win_over_flat_scalars_when_both_present(self):
        plan = RoutePlan(
            pattern=RoutePattern.ORBIT,
            category=AircraftCategory.GA,
            radius_nm=99.0,
            legs=[RouteLeg(pattern=RoutePattern.TRANSIT, radius_nm=4.0)],
        )
        assert len(plan.legs) == 1
        assert plan.pattern == RoutePattern.TRANSIT
        assert plan.radius_nm == 4.0


class TestWithLeg:
    """``model_copy(update=...)`` cannot touch a property, hence this helper."""

    def test_with_leg_updates_one_leg_only(self):
        plan = RoutePlan(
            category=AircraftCategory.GA,
            legs=[
                RouteLeg(pattern=RoutePattern.TRANSIT, radius_nm=5.0),
                RouteLeg(pattern=RoutePattern.ORBIT, radius_nm=3.0),
            ],
        )
        updated = plan.with_leg(1, radius_nm=9.0)
        assert updated.legs[0].radius_nm == 5.0
        assert updated.legs[1].radius_nm == 9.0

    def test_with_leg_does_not_mutate_the_original(self):
        plan = RoutePlan(pattern=RoutePattern.ORBIT, category=AircraftCategory.GA, radius_nm=5.0)
        plan.with_leg(0, radius_nm=20.0)
        assert plan.radius_nm == 5.0

    def test_with_leg_ignores_an_out_of_range_index(self):
        plan = RoutePlan(pattern=RoutePattern.ORBIT, category=AircraftCategory.GA, radius_nm=5.0)
        assert plan.with_leg(7, radius_nm=20.0).legs[0].radius_nm == 5.0

    def test_with_all_legs_updates_every_leg(self):
        plan = RoutePlan(
            category=AircraftCategory.GA,
            legs=[
                RouteLeg(pattern=RoutePattern.TRANSIT, radius_nm=5.0),
                RouteLeg(pattern=RoutePattern.ORBIT, radius_nm=3.0),
            ],
        )
        updated = plan.with_all_legs(altitude_ft=2000.0)
        assert [leg.altitude_ft for leg in updated.legs] == [2000.0, 2000.0]


class TestRouteLeg:
    def test_new_per_leg_dimensions_default_to_inert_values(self):
        leg = RouteLeg(pattern=RoutePattern.TRANSIT)
        assert leg.speed_bias == SpeedBias.NORMAL
        assert leg.altitude_min_ft is None
        assert leg.altitude_max_ft is None
        assert leg.anchor_lat is None
        assert leg.anchor_lng is None
        assert leg.has_anchor is False

    def test_has_anchor_requires_both_coordinates(self):
        assert RouteLeg(pattern=RoutePattern.ORBIT, anchor_lat=46.6, anchor_lng=-2.3).has_anchor
        assert not RouteLeg(pattern=RoutePattern.ORBIT, anchor_lat=46.6).has_anchor

    def test_oscillation_requires_both_bounds(self):
        band = RouteLeg(
            pattern=RoutePattern.MANEUVER, altitude_min_ft=1000.0, altitude_max_ft=3000.0
        )
        assert band.oscillates is True
        assert RouteLeg(pattern=RoutePattern.MANEUVER, altitude_min_ft=1000.0).oscillates is False

    def test_inverted_oscillation_bounds_are_ordered(self):
        leg = RouteLeg(
            pattern=RoutePattern.MANEUVER, altitude_min_ft=3000.0, altitude_max_ft=1000.0
        )
        assert leg.altitude_min_ft == 1000.0
        assert leg.altitude_max_ft == 3000.0

    def test_anchor_coordinates_are_range_checked(self):
        with pytest.raises(ValidationError):
            RouteLeg(pattern=RoutePattern.ORBIT, anchor_lat=91.0, anchor_lng=0.0)


class TestWaypointLegIndex:
    def test_defaults_to_the_first_leg(self):
        wp = Waypoint(
            lat=45.0,
            lng=-73.0,
            alt_ft=3000.0,
            speed_kts=120.0,
            heading_deg=90.0,
            phase="cruise",
            t_offset_s=0.0,
        )
        assert wp.leg_index == 0

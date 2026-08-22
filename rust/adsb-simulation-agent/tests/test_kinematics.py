"""Kinematic profiles and the physics helpers that constrain generated tracks."""

from __future__ import annotations

import math

import pytest

from adsb_simulation_agent.kinematics import (
    PROFILES,
    KinematicProfile,
    bearing_deg,
    climb_time_s,
    destination_point,
    great_circle_nm,
    max_heading_change_deg,
    normalize_heading,
    turn_radius_nm,
)
from adsb_simulation_agent.models import AircraftCategory


class TestProfiles:
    def test_every_category_has_a_profile(self):
        for category in AircraftCategory:
            assert category in PROFILES
            assert isinstance(PROFILES[category], KinematicProfile)

    @pytest.mark.parametrize("category", list(AircraftCategory))
    def test_speed_and_rate_bands_are_ordered_and_positive(self, category):
        p = PROFILES[category]
        for band in (
            p.cruise_speed_kts,
            p.climb_speed_kts,
            p.descent_speed_kts,
            p.approach_speed_kts,
            p.climb_rate_fpm,
            p.descent_rate_fpm,
            p.cruise_alt_ft,
        ):
            low, high = band
            assert low <= high, f"{category}: band {band} is inverted"
            assert low >= 0, f"{category}: band {band} has a negative floor"

    @pytest.mark.parametrize("category", list(AircraftCategory))
    def test_turn_rate_is_positive_and_bounded(self, category):
        # 0 would make turns impossible; >30 deg/s is beyond even aerobatic flight.
        assert 0 < PROFILES[category].max_turn_rate_dps <= 30

    def test_relative_performance_matches_reality(self):
        """The whole point of per-category profiles is that they *differ*."""
        airliner = PROFILES[AircraftCategory.AIRLINER]
        ga = PROFILES[AircraftCategory.GA]
        heli = PROFILES[AircraftCategory.HELICOPTER]
        fighter = PROFILES[AircraftCategory.FIGHTER]

        # Airliners cruise faster and higher than GA.
        assert airliner.cruise_speed_kts[0] > ga.cruise_speed_kts[1]
        assert airliner.cruise_alt_ft[0] > ga.cruise_alt_ft[1]
        # Helicopters turn far more tightly than airliners.
        assert heli.max_turn_rate_dps > airliner.max_turn_rate_dps
        # Fighters out-climb everything.
        assert fighter.climb_rate_fpm[1] > airliner.climb_rate_fpm[1]
        # Airliners are the least agile of the four.
        assert airliner.max_turn_rate_dps == min(p.max_turn_rate_dps for p in PROFILES.values())


class TestClimbTime:
    def test_matches_the_rate_definition(self):
        # 3000 ft at 1500 ft/min = 2 min = 120 s.
        assert climb_time_s(delta_alt_ft=3000, rate_fpm=1500) == pytest.approx(120.0)

    def test_is_direction_agnostic(self):
        """Descending 1000ft takes as long as climbing 1000ft at the same rate."""
        assert climb_time_s(-1000, 500) == pytest.approx(climb_time_s(1000, 500))

    def test_level_flight_takes_no_time(self):
        assert climb_time_s(0, 1500) == 0.0

    def test_rejects_nonpositive_rate(self):
        with pytest.raises(ValueError):
            climb_time_s(1000, 0)


class TestHeadingHelpers:
    @pytest.mark.parametrize(
        "raw,expected",
        [(0, 0), (359.5, 359.5), (360, 0), (450, 90), (-90, 270), (-1, 359)],
    )
    def test_normalize_wraps_into_0_360(self, raw, expected):
        assert normalize_heading(raw) == pytest.approx(expected)

    def test_max_heading_change_is_rate_times_time(self):
        # 3 deg/s sustained for 10 s = 30 degrees.
        assert max_heading_change_deg(3.0, 10.0) == pytest.approx(30.0)

    def test_zero_duration_permits_no_turn(self):
        assert max_heading_change_deg(3.0, 0.0) == 0.0


class TestGeodesy:
    def test_great_circle_known_distance(self):
        """One degree of latitude is ~60 NM by definition."""
        assert great_circle_nm(45.0, -73.6, 46.0, -73.6) == pytest.approx(60.0, rel=0.01)

    def test_great_circle_is_zero_for_identical_points(self):
        assert great_circle_nm(45.5, -73.6, 45.5, -73.6) == pytest.approx(0.0, abs=1e-9)

    def test_great_circle_is_symmetric(self):
        a = great_circle_nm(45.5, -73.6, 45.7, -73.2)
        b = great_circle_nm(45.7, -73.2, 45.5, -73.6)
        assert a == pytest.approx(b)

    @pytest.mark.parametrize(
        "lat2,lng2,expected",
        [(46.0, -73.6, 0.0), (45.0, -73.6, 180.0)],
    )
    def test_bearing_cardinal_directions(self, lat2, lng2, expected):
        assert bearing_deg(45.5, -73.6, lat2, lng2) == pytest.approx(expected, abs=0.5)

    def test_bearing_east_is_about_90(self):
        assert bearing_deg(45.5, -73.6, 45.5, -73.0) == pytest.approx(90.0, abs=0.5)

    def test_destination_point_round_trips_with_bearing_and_distance(self):
        """Projecting out and measuring back must agree — this is the invariant
        every pattern in geometry.py leans on."""
        lat, lng = destination_point(45.5, -73.6, bearing=42.0, distance_nm=7.5)
        assert great_circle_nm(45.5, -73.6, lat, lng) == pytest.approx(7.5, rel=1e-3)
        assert bearing_deg(45.5, -73.6, lat, lng) == pytest.approx(42.0, abs=0.2)

    def test_destination_point_zero_distance_is_a_noop(self):
        assert destination_point(45.5, -73.6, 90.0, 0.0) == pytest.approx((45.5, -73.6))


class TestTurnRadius:
    def test_faster_aircraft_need_wider_turns(self):
        slow = turn_radius_nm(speed_kts=80, turn_rate_dps=3.0)
        fast = turn_radius_nm(speed_kts=450, turn_rate_dps=3.0)
        assert fast > slow

    def test_higher_turn_rate_tightens_the_turn(self):
        loose = turn_radius_nm(speed_kts=250, turn_rate_dps=1.5)
        tight = turn_radius_nm(speed_kts=250, turn_rate_dps=6.0)
        assert tight < loose

    def test_matches_the_standard_rate_turn_formula(self):
        """r = v / (omega) with consistent units. At 3 deg/s a full 360 takes
        120 s, so the circumference is speed * 120s and r = C / 2pi."""
        speed_kts = 300.0
        radius = turn_radius_nm(speed_kts, 3.0)
        circumference_nm = speed_kts * (120.0 / 3600.0)
        assert radius == pytest.approx(circumference_nm / (2 * math.pi), rel=1e-6)

    def test_rejects_nonpositive_turn_rate(self):
        with pytest.raises(ValueError):
            turn_radius_nm(250, 0)

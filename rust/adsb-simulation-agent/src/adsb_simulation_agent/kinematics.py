"""Per-category performance envelopes plus the geodesy/physics helpers.

Everything here is pure and deterministic — no LLM, no I/O. This module is the
whole of DC3 ("tracks shall follow basic flight dynamics rules"): the profiles
below bound what a generated track is allowed to do, and ``validate.py`` checks
finished tracks against these same numbers.

Units are deliberately explicit in every name (``_nm``, ``_kts``, ``_fpm``,
``_dps``, ``_ft``, ``_s``) because mixing them silently is the classic way these
calculations go wrong.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .models import AircraftCategory

EARTH_RADIUS_NM = 3440.065
"""Mean Earth radius in nautical miles."""

Band = tuple[float, float]
"""An inclusive ``(min, max)`` range that a sampled value must fall within."""


@dataclass(frozen=True)
class KinematicProfile:
    """The performance envelope of one aircraft category.

    These are engineering approximations chosen for a *visualization* tool: they
    are internally consistent and produce plausible-looking tracks, not
    certified performance data. They were picked to match the aircraft already
    represented in the desktop app's hand-authored demo flights.
    """

    cruise_speed_kts: Band
    climb_speed_kts: Band
    descent_speed_kts: Band
    approach_speed_kts: Band
    climb_rate_fpm: Band
    descent_rate_fpm: Band
    max_turn_rate_dps: float
    """Sustained turn rate cap. 3 deg/s is the civil "standard rate turn"."""

    cruise_alt_ft: Band
    max_bank_deg: float
    """Informational — the bank angle the turn rate above corresponds to."""


PROFILES: dict[AircraftCategory, KinematicProfile] = {
    AircraftCategory.AIRLINER: KinematicProfile(
        cruise_speed_kts=(420, 480),
        climb_speed_kts=(250, 320),
        descent_speed_kts=(250, 300),
        approach_speed_kts=(130, 160),
        climb_rate_fpm=(1800, 3000),
        descent_rate_fpm=(1500, 2500),
        max_turn_rate_dps=3.0,
        cruise_alt_ft=(28000, 40000),
        max_bank_deg=25,
    ),
    AircraftCategory.GA: KinematicProfile(
        cruise_speed_kts=(90, 160),
        climb_speed_kts=(70, 100),
        descent_speed_kts=(90, 130),
        approach_speed_kts=(60, 80),
        climb_rate_fpm=(500, 900),
        descent_rate_fpm=(400, 700),
        max_turn_rate_dps=6.0,
        cruise_alt_ft=(1000, 8000),
        max_bank_deg=30,
    ),
    AircraftCategory.HELICOPTER: KinematicProfile(
        cruise_speed_kts=(60, 130),
        climb_speed_kts=(40, 70),
        descent_speed_kts=(40, 70),
        approach_speed_kts=(0, 40),
        climb_rate_fpm=(500, 1500),
        descent_rate_fpm=(400, 1200),
        max_turn_rate_dps=10.0,
        cruise_alt_ft=(300, 2500),
        max_bank_deg=20,
    ),
    AircraftCategory.FIGHTER: KinematicProfile(
        cruise_speed_kts=(300, 500),
        climb_speed_kts=(350, 500),
        descent_speed_kts=(300, 450),
        approach_speed_kts=(150, 180),
        climb_rate_fpm=(6000, 12000),
        descent_rate_fpm=(4000, 8000),
        max_turn_rate_dps=15.0,
        cruise_alt_ft=(5000, 25000),
        max_bank_deg=60,
    ),
}


def climb_time_s(delta_alt_ft: float, rate_fpm: float) -> float:
    """Seconds to change altitude by ``delta_alt_ft`` at ``rate_fpm``.

    Sign-agnostic: callers pass a descent rate for descents, so only the
    magnitude of the altitude change matters.
    """
    if rate_fpm <= 0:
        raise ValueError(f"rate_fpm must be positive, got {rate_fpm}")
    return abs(delta_alt_ft) / rate_fpm * 60.0


def normalize_heading(deg: float) -> float:
    """Wrap any angle into ``[0, 360)`` — the convention the frontend uses."""
    return deg % 360.0


def max_heading_change_deg(turn_rate_dps: float, duration_s: float) -> float:
    """The largest heading change physically available in ``duration_s``.

    This is the clamp that stops generated tracks from containing instantaneous
    90-degree kinks, which is what made the hand-authored demo routes look
    obviously synthetic.
    """
    return turn_rate_dps * duration_s


def turn_radius_nm(speed_kts: float, turn_rate_dps: float) -> float:
    """Radius of a level turn flown at ``speed_kts`` and ``turn_rate_dps``.

    Derived straight from the definition of angular velocity: a full circle
    takes ``360 / turn_rate_dps`` seconds, so the circumference is the distance
    covered in that time and ``r = C / 2pi``.
    """
    if turn_rate_dps <= 0:
        raise ValueError(f"turn_rate_dps must be positive, got {turn_rate_dps}")
    seconds_per_circle = 360.0 / turn_rate_dps
    circumference_nm = speed_kts * (seconds_per_circle / 3600.0)
    return circumference_nm / (2.0 * math.pi)


def great_circle_nm(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in nautical miles (haversine).

    Haversine rather than the flat-earth approximation the frontend uses for
    heading: patterns can span tens of NM, and the error compounds across the
    many waypoints of a long route.
    """
    p1, p2 = math.radians(lat1), math.radians(lat2)
    d_phi = p2 - p1
    d_lambda = math.radians(lng2 - lng1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(d_lambda / 2) ** 2
    return 2 * EARTH_RADIUS_NM * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Initial great-circle bearing from point 1 to point 2, in ``[0, 360)``."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    d_lambda = math.radians(lng2 - lng1)
    x = math.sin(d_lambda) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(d_lambda)
    return normalize_heading(math.degrees(math.atan2(x, y)))


def destination_point(
    lat: float, lng: float, bearing: float, distance_nm: float
) -> tuple[float, float]:
    """Project from a point along a bearing — the inverse of the two above.

    Every pattern in ``geometry.py`` is built by projecting from the origin, so
    this and ``bearing_deg``/``great_circle_nm`` must round-trip exactly.
    """
    if distance_nm == 0:
        return (lat, lng)
    angular = distance_nm / EARTH_RADIUS_NM
    theta = math.radians(bearing)
    p1 = math.radians(lat)
    lambda1 = math.radians(lng)

    sin_p2 = math.sin(p1) * math.cos(angular) + math.cos(p1) * math.sin(angular) * math.cos(theta)
    p2 = math.asin(max(-1.0, min(1.0, sin_p2)))
    lambda2 = lambda1 + math.atan2(
        math.sin(theta) * math.sin(angular) * math.cos(p1),
        math.cos(angular) - math.sin(p1) * math.sin(p2),
    )
    # Re-wrap longitude into [-180, 180) so results stay comparable.
    return (math.degrees(p2), (math.degrees(lambda2) + 540.0) % 360.0 - 180.0)

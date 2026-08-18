"""Classify a free-text route hint into a structured ``RoutePlan``.

This is the *only* place an LLM touches trajectory generation, and its output
surface is deliberately tiny: per leg, a pattern enum plus a handful of scalars.
The model is a 7B running locally, so everything here assumes messy output —
fenced JSON, prose padding, quoted numbers, invented enum values, out-of-range
scalars — and degrades to a sensible default rather than raising. A demo feature
must never break the chat turn it was invoked from.

Coordinates are the one place the model is trusted with numbers, and only
barely. It may *copy* a latitude/longitude the user wrote, to say which leg that
point belongs to — but ``extract_coordinates`` reads the user's raw words
independently, and ``corroborate_anchors`` discards any anchor that cannot be
matched against them. So the model chooses the *assignment*; the user's own text
remains the only source of the *values*. A hallucinated position never reaches
geometry.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from .config import settings
from .geometry import LatLng, default_plan_for
from .models import AircraftCategory, RouteLeg, RoutePattern, RoutePlan, SpeedBias

logger = logging.getLogger("adsb_simulation_agent.intent")

INTENT_SYSTEM_PROMPT = """You classify aircraft route requests into a fixed schema.

Reply with ONLY a JSON object. No prose, no explanation, no markdown fences.

A route is a list of LEGS, flown in order by one aircraft. Split the request
into one leg per thing the aircraft does. "Fly from A, circle over B, then go
to C" is three legs. A simple request is one leg.

Top level: {"legs": [ ...leg objects... ]}

Each leg object:
- "pattern": one of "orbit", "racetrack", "transit", "approach", "maneuver"
    orbit     - circling one point (loitering, holding, watching something)
    racetrack - back-and-forth patrol along a line
    transit   - flying straight from one place to another, passing through
    approach  - descending straight in to land
    maneuver  - aerobatic figure-eight display, dogfighting, manoeuvering
- "radius_nm": number 0.5-100. Size of the pattern, or half the length of a
  straight leg. Small (1-5) for local/city work, large (15-40) for airliners.
- "bearing_deg": number 0-359. Compass direction the pattern is oriented along.
- "altitude_ft": number 0-60000, or null if unspecified.
- "altitude_min_ft" and "altitude_max_ft": numbers, ONLY when the request asks
  the aircraft to go up and down between two heights on this leg.
- "turn_count": integer 1-10. Laps or repetitions.
- "speed_bias": "slow", "normal" or "fast". Use "fast" for "at high speed",
  "slow" for "slowly" or "loitering".
- "anchor_lat" and "anchor_lng": ONLY when the user wrote a latitude and
  longitude for this leg. Copy the numbers EXACTLY as they appear in the
  request. NEVER invent, estimate or look up coordinates — not for a city, an
  island, an airport or any other place name. Omit both fields if the user did
  not write numbers. Invented coordinates are discarded anyway.

You describe the SHAPE of the route; exact positions are computed separately.

Example request: "a fighter coming from (46.49, -1.79) at 10000ft, manoeuvering
fast over (46.69, -2.35) going up and down between 1000 and 3000 feet, then
heading to (46.71, -1.92)"
Example reply: {"legs": [
{"pattern": "transit", "altitude_ft": 10000, "anchor_lat": 46.69,
 "anchor_lng": -2.35},
{"pattern": "maneuver", "radius_nm": 5, "turn_count": 3, "speed_bias": "fast",
 "altitude_min_ft": 1000, "altitude_max_ft": 3000, "anchor_lat": 46.69,
 "anchor_lng": -2.35},
{"pattern": "transit", "anchor_lat": 46.71, "anchor_lng": -1.92}]}"""


# Near-misses a small model reaches for instead of the exact enum value.
_PATTERN_SYNONYMS: dict[str, RoutePattern] = {
    "holding": RoutePattern.ORBIT,
    "hold": RoutePattern.ORBIT,
    "circle": RoutePattern.ORBIT,
    "circling": RoutePattern.ORBIT,
    "loiter": RoutePattern.ORBIT,
    "patrol": RoutePattern.RACETRACK,
    "survey": RoutePattern.RACETRACK,
    "landing": RoutePattern.APPROACH,
    "land": RoutePattern.APPROACH,
    "final": RoutePattern.APPROACH,
    "arrival": RoutePattern.APPROACH,
    "overflight": RoutePattern.TRANSIT,
    "cruise": RoutePattern.TRANSIT,
    "crossing": RoutePattern.TRANSIT,
    "aerobatic": RoutePattern.MANEUVER,
    "aerobatics": RoutePattern.MANEUVER,
    "display": RoutePattern.MANEUVER,
    "figure-eight": RoutePattern.MANEUVER,
    "figure_eight": RoutePattern.MANEUVER,
}


COMPACT_INTENT_SYSTEM_PROMPT = """Convert the flight request to JSON. Output JSON only.

{"legs":[{leg},...]}   one leg per thing the aircraft does, in order.

leg fields (all optional except pattern):
 pattern: orbit|racetrack|transit|approach|maneuver
   orbit=circling, racetrack=patrol, transit=flying A to B,
   approach=landing, maneuver=aerobatics/dogfight
 radius_nm: 0.5-100   bearing_deg: 0-359   turn_count: 1-10
 altitude_ft: 0-60000
 altitude_min_ft + altitude_max_ft: only if it goes up and down between two heights
 speed_bias: slow|normal|fast
 anchor_lat + anchor_lng: ONLY numbers the user typed. Never invent them,
   never look up a place name. Omit if the user gave no numbers.

Example: "fighter from (46.49, -1.79) at 10000ft, fast aerobatics over
(46.69, -2.35) between 1000 and 3000ft, then to (46.71, -1.92)"
{"legs":[{"pattern":"transit","altitude_ft":10000,"anchor_lat":46.69,"anchor_lng":-2.35},
{"pattern":"maneuver","speed_bias":"fast","altitude_min_ft":1000,"altitude_max_ft":3000,
"anchor_lat":46.69,"anchor_lng":-2.35},
{"pattern":"transit","anchor_lat":46.71,"anchor_lng":-1.92}]}"""

PROMPT_STYLES: dict[str, str] = {
    "full": INTENT_SYSTEM_PROMPT,
    "compact": COMPACT_INTENT_SYSTEM_PROMPT,
}


def select_intent_prompt(style: str | None) -> str:
    """The system prompt for a given style, defaulting to the full one.

    An unrecognised style falls back to ``full`` rather than raising: a typo in
    ``.env`` should not silently switch the service to a weaker prompt, and it
    must certainly not take the service down.
    """
    if not style:
        return INTENT_SYSTEM_PROMPT
    chosen = PROMPT_STYLES.get(style.strip().lower())
    if chosen is None:
        logger.warning(
            "Unknown ADSB_SIM_AGENT_PROMPT_STYLE %r; using 'full'. Known styles: %s",
            style,
            ", ".join(sorted(PROMPT_STYLES)),
        )
        return INTENT_SYSTEM_PROMPT
    return chosen


def build_intent_messages(
    hint: str, category: AircraftCategory, prompt_style: str | None = None
) -> list[Any]:
    """System + user messages for the classification call.

    ``prompt_style`` picks between the full prompt and the compact one; it
    defaults to whatever is configured. The compact variant is about a third the
    size, which matters because prompt length is charged against the same token
    budget as the answer — on a constrained (or reasoning-heavy) model the full
    prompt can leave no room to reply at all.
    """
    from langchain_core.messages import HumanMessage, SystemMessage

    style = settings.prompt_style if prompt_style is None else prompt_style
    return [
        SystemMessage(content=select_intent_prompt(style)),
        HumanMessage(content=f"Aircraft type: {category.value}\nRequest: {hint}"),
    ]


def _extract_json_object(raw: str) -> dict[str, Any] | None:
    """Pull the first JSON object out of possibly-messy model output."""
    if not raw or not raw.strip():
        return None

    # Strip markdown fences if present.
    fenced = re.search(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL)
    candidate = fenced.group(1) if fenced else raw

    try:
        parsed = json.loads(candidate.strip())
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass

    # Fall back to the first {...} span embedded in prose.
    match = re.search(r"\{.*\}", candidate, re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _coerce_float(value: Any) -> float | None:
    """Accept numbers the model quoted as strings."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _resolve_pattern(value: Any) -> RoutePattern | None:
    if not isinstance(value, str):
        return None
    key = value.strip().lower().replace(" ", "_")
    try:
        return RoutePattern(key)
    except ValueError:
        return _PATTERN_SYNONYMS.get(key)


RETRY_MAX_TOKENS = 4096
"""Floor for the one retry after a truncated classification.

Reasoning effort scales with how *vague* the request is, not how long it is:
"circling the port" costs ~430 completion tokens, but a bare "downtown" costs
~1450 because the model deliberates over what was meant. Raising the normal
budget to cover that would slow every call, so the tail is handled by retrying.
"""

RETRY_GROWTH_FACTOR = 2.0
"""How much more room the retry gets than the call that ran out of it."""


def retry_token_budget(configured_max_tokens: int) -> int:
    """Token budget for the truncation retry — always larger than what just failed.

    ``RETRY_MAX_TOKENS`` alone is a *floor*, not the answer: ``max_tokens`` is
    configurable, so a deployment that raised it above the constant inverted the
    retry entirely. The first call got 8192 tokens, ran out mid-reasoning, and
    the "retry with a larger budget" then asked for 4096 — half as much room for
    a problem that had already proved too big. It could not succeed, and cost a
    second full LLM round-trip to fail.
    """
    return max(RETRY_MAX_TOKENS, int(configured_max_tokens * RETRY_GROWTH_FACTOR))


MAX_LEGS = 6
"""Cap on route complexity. Beyond this a small model is padding, not planning,
and the resulting track is unreadable on a map anyway."""

ANCHOR_MATCH_TOLERANCE_DEG = 0.02
"""How close a model-supplied anchor must be to a coordinate the user actually
wrote. Roughly 1 NM — wide enough to forgive rounding (46.69154 -> 46.69),
far too narrow to admit a different place."""

# A decimal-degree pair, optionally parenthesised: "(46.49365, -1.79214)" or
# "45.5,-73.6". A decimal point is required on both numbers: bare integer pairs
# in these requests are almost always altitudes, counts or speeds ("between
# 1000 and 3000 feet"), and reading those as a position would put aircraft in
# the wrong hemisphere.
_COORD_PAIR_RE = re.compile(r"(?<![\d.])(-?\d{1,3}\.\d+)\s*[,/]\s*(-?\d{1,3}\.\d+)(?![\d.])")


def extract_coordinates(hint: str | None) -> list[LatLng]:
    """Every latitude/longitude pair the user actually wrote, in order.

    This is the *authority* on which coordinates exist. The model's job is to
    say which leg each one belongs to; it never gets to say what they are.
    """
    if not hint:
        return []
    found: list[LatLng] = []
    for lat_text, lng_text in _COORD_PAIR_RE.findall(hint):
        lat, lng = float(lat_text), float(lng_text)
        if -90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0:
            found.append((lat, lng))
    return found


def _match_coordinate(
    lat: float | None, lng: float | None, coordinates: list[LatLng]
) -> LatLng | None:
    """The user-written coordinate this anchor refers to, if any.

    Returns the *user's* numbers rather than the model's, so a rounded copy
    snaps back to what was actually asked for.
    """
    if lat is None or lng is None:
        return None
    for candidate in coordinates:
        if (
            abs(candidate[0] - lat) <= ANCHOR_MATCH_TOLERANCE_DEG
            and abs(candidate[1] - lng) <= ANCHOR_MATCH_TOLERANCE_DEG
        ):
            return candidate
    return None


def corroborate_anchors(legs: list[RouteLeg], coordinates: list[LatLng]) -> list[RouteLeg]:
    """Keep only anchors that can be traced back to the user's own words.

    Two paths in, and nothing else:

    * the model copied a coordinate the user wrote — kept, snapped to the
      user's numbers;
    * the model anchored nothing at all, and there is exactly one coordinate
      per leg — assigned in order.

    Anything else is dropped. In particular a partial or mismatched alignment is
    *not* guessed at: placing a leg over the wrong point is worse than leaving
    it to continue from where the previous leg ended.
    """
    if not coordinates:
        return [
            leg.model_copy(update={"anchor_lat": None, "anchor_lng": None})
            if leg.has_anchor
            else leg
            for leg in legs
        ]

    corroborated: list[RouteLeg] = []
    kept = 0
    for leg in legs:
        match = _match_coordinate(leg.anchor_lat, leg.anchor_lng, coordinates)
        if match is None:
            if leg.has_anchor:
                logger.info(
                    "Discarding uncorroborated anchor (%s, %s) — not in the request",
                    leg.anchor_lat,
                    leg.anchor_lng,
                )
            corroborated.append(leg.model_copy(update={"anchor_lat": None, "anchor_lng": None}))
            continue
        kept += 1
        corroborated.append(leg.model_copy(update={"anchor_lat": match[0], "anchor_lng": match[1]}))

    if kept == 0 and len(coordinates) == len(corroborated):
        corroborated = [
            leg.model_copy(update={"anchor_lat": lat, "anchor_lng": lng})
            for leg, (lat, lng) in zip(corroborated, coordinates)
        ]

    return corroborated


def _resolve_speed_bias(value: Any) -> SpeedBias:
    """Anything unrecognised is just "normal" — speed is a nuance, not a route."""
    if not isinstance(value, str):
        return SpeedBias.NORMAL
    try:
        return SpeedBias(value.strip().lower())
    except ValueError:
        return SpeedBias.NORMAL


def _parse_leg(data: dict[str, Any], fallback: RouteLeg) -> RouteLeg | None:
    """One leg object, clamped. ``None`` when the pattern is unusable."""
    pattern = _resolve_pattern(data.get("pattern"))
    if pattern is None:
        return None

    radius = _coerce_float(data.get("radius_nm"))
    bearing = _coerce_float(data.get("bearing_deg"))
    altitude = _coerce_float(data.get("altitude_ft"))
    turns = _coerce_float(data.get("turn_count"))
    alt_min = _coerce_float(data.get("altitude_min_ft"))
    alt_max = _coerce_float(data.get("altitude_max_ft"))

    return RouteLeg(
        pattern=pattern,
        radius_nm=_clamp(radius, 0.5, 100.0, fallback.radius_nm),
        # Bearings wrap rather than clamp — 450 degrees means 90, not "too big".
        bearing_deg=(bearing % 360.0) if bearing is not None else fallback.bearing_deg,
        altitude_ft=_clamp(altitude, 0.0, 60000.0, None) if altitude is not None else None,
        altitude_min_ft=_clamp(alt_min, 0.0, 60000.0, None) if alt_min is not None else None,
        altitude_max_ft=_clamp(alt_max, 0.0, 60000.0, None) if alt_max is not None else None,
        turn_count=int(_clamp(turns, 1, 10, fallback.turn_count)),
        speed_bias=_resolve_speed_bias(data.get("speed_bias")),
        # Provisional — corroborate_anchors decides whether these survive.
        anchor_lat=_clamp(_coerce_float(data.get("anchor_lat")), -90.0, 90.0, None),
        anchor_lng=_clamp(_coerce_float(data.get("anchor_lng")), -180.0, 180.0, None),
    )


def _reasoning_exhaustion_note(usage: dict[str, Any] | None) -> str:
    """Explain a budget that went entirely on reasoning, if that is what happened.

    Reasoning models report `reasoning_tokens` separately. When that number is
    essentially the whole completion, the model thought until it ran out and
    never wrote an answer — no prompt or budget change fixes that, only a
    different model (or a lower reasoning effort). Worth saying explicitly,
    because the symptom is indistinguishable from a transport fault.
    """
    if not isinstance(usage, dict):
        return ""
    details = usage.get("completion_tokens_details") or {}
    reasoning = details.get("reasoning_tokens") if isinstance(details, dict) else None
    completion = usage.get("completion_tokens")
    if not reasoning or not completion:
        return ""
    if reasoning < completion * 0.9:
        return ""
    return (
        f" The model spent {reasoning}/{completion} completion tokens on internal "
        f"reasoning and emitted no answer — this is a reasoning model being asked "
        f"to do a classification. Use a non-reasoning model (or a lower reasoning "
        f"effort) for ADSB_SIM_AGENT_MODEL; raising max_tokens will not help."
    )


def parse_plan_json(
    raw: str,
    category: AircraftCategory,
    seed: int | None = None,
    finish_reason: str | None = None,
    hint: str | None = None,
    usage: dict[str, Any] | None = None,
) -> RoutePlan:
    """Turn raw model output into a valid ``RoutePlan``, never raising.

    Scalars are *clamped* rather than rejected: losing a correctly-identified
    pattern because the model guessed a silly radius would be a poor trade.
    ``category`` always comes from the caller — it is a request parameter, not
    the model's to choose. ``hint`` is the user's raw words, and is the only
    source of truth for coordinates.
    """
    fallback = default_plan_for(category, seed=seed)
    data = _extract_json_object(raw)
    if not data:
        # Logged at WARNING because this is indistinguishable from success at
        # the API level but silently discards the user's route request. The
        # usual cause is a reasoning model whose max_tokens budget ran out
        # before it emitted any content (finish_reason='length', content='').
        logger.warning(
            "Route hint could not be classified; using a default plan. "
            "finish_reason=%s, model returned %d chars: %r.%s",
            finish_reason or "unknown",
            len(raw or ""),
            (raw or "")[:200],
            _reasoning_exhaustion_note(usage),
        )
        return fallback

    # Both shapes are accepted: the multi-leg one asked for, and the bare
    # single object a model reaches for when the request is simple.
    raw_legs = data.get("legs")
    if not isinstance(raw_legs, list) or not raw_legs:
        raw_legs = [data]

    fallback_leg = fallback.legs[0]
    legs = [
        parsed
        for item in raw_legs[:MAX_LEGS]
        if isinstance(item, dict) and (parsed := _parse_leg(item, fallback_leg)) is not None
    ]
    if not legs:
        return fallback

    return RoutePlan(category=category, legs=corroborate_anchors(legs, extract_coordinates(hint)))


def _clamp(value: float | None, lo: float, hi: float, default: float | None) -> Any:
    if value is None:
        return default
    return min(max(value, lo), hi)


async def parse_route_hint(
    hint: str | None,
    category: AircraftCategory,
    llm: Any | None,
    seed: int | None = None,
) -> RoutePlan:
    """Classify ``hint`` into a ``RoutePlan``.

    Falls back to a seeded default plan when there is no hint, no LLM, or the
    call fails — a dead LM Studio degrades the feature, it does not break it.
    """
    if not hint or not hint.strip():
        return default_plan_for(category, seed=seed)
    if llm is None:
        logger.debug("No LLM configured; using default plan for %s", category.value)
        return default_plan_for(category, seed=seed)

    messages = build_intent_messages(hint, category)

    result = await _classify(llm, messages)
    if result is None:
        return default_plan_for(category, seed=seed)

    raw, finish_reason, usage = result

    # A truncated answer means the model was still reasoning when the budget
    # ran out — the request was fine, there just wasn't room. Retry once with a
    # larger budget rather than silently discarding the user's route.
    if _extract_json_object(raw) is None and finish_reason == "length":
        budget = retry_token_budget(settings.max_tokens)
        logger.info(
            "Classification truncated (finish_reason=length); retrying with %d tokens",
            budget,
        )
        retried = await _classify(llm, messages, max_tokens=budget)
        if retried is not None and _extract_json_object(retried[0]) is not None:
            raw, finish_reason, usage = retried
        elif retried is not None:
            # Keep the retry's accounting: it is the more informative failure,
            # having been given the bigger budget.
            usage = retried[2]

    return parse_plan_json(
        raw, category, seed=seed, finish_reason=finish_reason, hint=hint, usage=usage
    )


async def _classify(
    llm: Any,
    messages: list[Any],
    max_tokens: int | None = None,
) -> tuple[str, str | None, dict[str, Any] | None] | None:
    """One classification call. Returns ``(content, finish_reason, usage)``, or None on failure.

    ``max_tokens`` overrides the model's configured budget for this call only,
    via LangChain's ``.bind()``. Guarded with ``hasattr`` so plain test doubles
    without a ``bind`` method still work.
    """
    target = llm
    if max_tokens is not None and hasattr(llm, "bind"):
        target = llm.bind(max_tokens=max_tokens)

    try:
        response = await target.ainvoke(messages)
    except Exception as e:  # noqa: BLE001 — any LLM failure degrades gracefully
        logger.warning("Route-hint classification failed (%s); using default plan", e)
        return None

    raw = getattr(response, "content", "") or ""
    metadata = getattr(response, "response_metadata", None) or {}
    finish_reason = metadata.get("finish_reason") if isinstance(metadata, dict) else None
    usage = metadata.get("token_usage") if isinstance(metadata, dict) else None
    return (raw if isinstance(raw, str) else str(raw), finish_reason, usage)

"""Classify a free-text route hint into a structured ``RoutePlan``.

This is the *only* place an LLM touches trajectory generation, and its output
surface is deliberately tiny: a pattern enum plus four scalars. The model is a
7B running locally, so everything here assumes messy output — fenced JSON,
prose padding, quoted numbers, invented enum values, out-of-range scalars — and
degrades to a sensible default rather than raising. A demo feature must never
break the chat turn it was invoked from.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from .geometry import default_plan_for
from .models import AircraftCategory, RoutePattern, RoutePlan

logger = logging.getLogger("adsb_simulation_agent.intent")

INTENT_SYSTEM_PROMPT = """You classify aircraft route requests into a fixed schema.

Reply with ONLY a JSON object. No prose, no explanation, no markdown fences.

Fields:
- "pattern": one of "orbit", "racetrack", "transit", "approach", "maneuver"
    orbit     - circling one point (loitering, holding, watching something)
    racetrack - back-and-forth patrol along a line
    transit   - flying straight across the area, passing through
    approach  - descending straight in to land
    maneuver  - aerobatic figure-eight display
- "radius_nm": number 0.5-100. Size of the pattern, or half the length of a
  straight leg. Small (1-5) for local/city work, large (15-40) for airliners.
- "bearing_deg": number 0-359. Compass direction the pattern is oriented along.
- "altitude_ft": number 0-60000, or null if unspecified.
- "turn_count": integer 1-10. Laps or repetitions.

NEVER output coordinates, latitude, longitude or waypoints. You describe the
SHAPE of the route only; the exact positions are computed separately.

Example: {"pattern": "orbit", "radius_nm": 2.5, "bearing_deg": 0,
"altitude_ft": 1500, "turn_count": 3}"""


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


def build_intent_messages(hint: str, category: AircraftCategory) -> list[Any]:
    """System + user messages for the classification call."""
    from langchain_core.messages import HumanMessage, SystemMessage

    return [
        SystemMessage(content=INTENT_SYSTEM_PROMPT),
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
"""Budget for the one retry after a truncated classification.

Reasoning effort scales with how *vague* the request is, not how long it is:
"circling the port" costs ~430 completion tokens, but a bare "downtown" costs
~1450 because the model deliberates over what was meant. Raising the normal
budget to cover that would slow every call, so the tail is handled by retrying.
"""


def parse_plan_json(
    raw: str,
    category: AircraftCategory,
    seed: int | None = None,
    finish_reason: str | None = None,
) -> RoutePlan:
    """Turn raw model output into a valid ``RoutePlan``, never raising.

    Scalars are *clamped* rather than rejected: losing a correctly-identified
    pattern because the model guessed a silly radius would be a poor trade.
    ``category`` always comes from the caller — it is a request parameter, not
    the model's to choose.
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
            "finish_reason=%s, model returned %d chars: %r",
            finish_reason or "unknown",
            len(raw or ""),
            (raw or "")[:200],
        )
        return fallback

    pattern = _resolve_pattern(data.get("pattern"))
    if pattern is None:
        return fallback

    radius = _coerce_float(data.get("radius_nm"))
    bearing = _coerce_float(data.get("bearing_deg"))
    altitude = _coerce_float(data.get("altitude_ft"))
    turns = _coerce_float(data.get("turn_count"))

    return RoutePlan(
        pattern=pattern,
        category=category,
        radius_nm=_clamp(radius, 0.5, 100.0, fallback.radius_nm),
        # Bearings wrap rather than clamp — 450 degrees means 90, not "too big".
        bearing_deg=(bearing % 360.0) if bearing is not None else fallback.bearing_deg,
        altitude_ft=_clamp(altitude, 0.0, 60000.0, None) if altitude is not None else None,
        turn_count=int(_clamp(turns, 1, 10, fallback.turn_count)),
    )


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

    raw, finish_reason = result

    # A truncated answer means the model was still reasoning when the budget
    # ran out — the request was fine, there just wasn't room. Retry once with a
    # larger budget rather than silently discarding the user's route.
    if _extract_json_object(raw) is None and finish_reason == "length":
        logger.info(
            "Classification truncated (finish_reason=length); retrying with %d tokens",
            RETRY_MAX_TOKENS,
        )
        retried = await _classify(llm, messages, max_tokens=RETRY_MAX_TOKENS)
        if retried is not None and _extract_json_object(retried[0]) is not None:
            raw, finish_reason = retried

    return parse_plan_json(raw, category, seed=seed, finish_reason=finish_reason)


async def _classify(
    llm: Any,
    messages: list[Any],
    max_tokens: int | None = None,
) -> tuple[str, str | None] | None:
    """One classification call. Returns ``(content, finish_reason)``, or None on failure.

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
    return (raw if isinstance(raw, str) else str(raw), finish_reason)

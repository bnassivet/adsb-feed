"""Scenario description generation — a single-shot LLM summarisation call.

Deliberately *not* the ReAct graph. Describing a scenario needs no tools, no
data lookup and no multi-hop reasoning: the desktop app already holds the track
data and sends a digest of it. Routing this through `graph.py` would mean the
model could wander off calling DuckDB tools when all it has to do is write two
sentences about the payload in front of it.

The `model=` keyword is the same injection seam `build_agent_graph` uses, so
tests never touch a real LLM endpoint.
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from .config import settings
from .models import DescribeScenarioRequest, TrackDigest
from .reasoning import reasoning_kwargs

SYSTEM_PROMPT = """\
You write short factual descriptions of air-traffic simulation scenarios.

Reply with at most 4 sentences of plain prose and nothing else. No preamble, no
markdown, no bullet points, no headings, no quotes around your answer.

Say what happens in the scenario at a glance: which aircraft are involved, what
each one is doing, and how they are timed relative to each other. Write it for
someone skimming a list of scenarios to find the one they want.

Do not recite the flight data. No altitudes, no speeds, no coordinates, no
waypoint counts, no per-aircraft breakdown of the trajectory — those are already
on screen. Do not invent detail that is not in the data you are given.\
"""

# Openers small local models reach for despite being told not to. Matched on a
# lowercased prefix up to the first colon, so only a genuine preamble is cut.
_PREAMBLE_MARKERS = (
    "here is",
    "here's",
    "sure",
    "certainly",
    "description",
    "scenario description",
    "of course",
)


def _describe_track(track: TrackDigest) -> str:
    """One human-readable line per track.

    Prose rather than JSON: a 7B model summarises prose far more reliably than
    it summarises a nested object, and null fields can simply be left out
    instead of leaking into the prompt as `None`.
    """
    parts = [f"- {track.callsign} ({track.category})"]

    if track.start_offset_s > 0:
        parts.append(f"enters {track.start_offset_s:g} s into the scenario")
    else:
        parts.append("present from the start")

    # The route hint is what the aircraft was *asked* to do, so it beats every
    # kinematic figure derived from the resulting waypoints — and those figures
    # are exactly the detail the description is supposed to leave out. Identity
    # and timing stay: neither is derivable from a route hint.
    if track.route and track.route.strip():
        parts.append(f"route: {track.route.strip()}")
        return ", ".join(parts)

    if track.waypoint_count == 0:
        parts.append("has no route yet")
        return ", ".join(parts)

    parts.append(f"flies for about {track.duration_s:g} s")

    if track.phases:
        parts.append("phases: " + " then ".join(track.phases))

    if track.alt_ft_min is not None and track.alt_ft_max is not None:
        if track.alt_ft_min == track.alt_ft_max:
            parts.append(f"level at {track.alt_ft_min:g} ft")
        else:
            parts.append(f"altitude {track.alt_ft_min:g} to {track.alt_ft_max:g} ft")

    if track.speed_kts_min is not None and track.speed_kts_max is not None:
        parts.append(f"speed {track.speed_kts_min:g} to {track.speed_kts_max:g} kts")

    if (
        track.start_lat is not None
        and track.start_lng is not None
        and track.end_lat is not None
        and track.end_lng is not None
    ):
        parts.append(
            f"from {track.start_lat:.3f},{track.start_lng:.3f} "
            f"to {track.end_lat:.3f},{track.end_lng:.3f}"
        )

    return ", ".join(parts)


def build_describe_prompt(request: DescribeScenarioRequest) -> str:
    """Render the user-side prompt. Pure — the interesting half to test."""
    lines = [f'Scenario name: "{request.name}"', ""]

    if not request.tracks:
        lines.append("This scenario has no tracks yet.")
    else:
        count = len(request.tracks)
        lines.append(f"It contains {count} track{'' if count == 1 else 's'}:")
        lines.extend(_describe_track(t) for t in request.tracks)

    lines.extend(["", "Write the description now."])
    return "\n".join(lines)


def _clean(content: str) -> str:
    """Strip the conversational packaging small models add anyway."""
    text = content.strip()

    # Drop a leading "Here is the description:" style opener, but only when the
    # colon comes early — a real sentence can contain a colon further in.
    head, sep, tail = text.partition(":")
    if sep and len(head) <= 60 and any(head.lower().lstrip().startswith(m) for m in _PREAMBLE_MARKERS):
        text = tail.strip()

    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1].strip()

    return text


def _build_model() -> Any:
    """Construct the chat model from settings, mirroring `graph.py`."""
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        model=settings.model,
        temperature=settings.temperature,
        max_tokens=settings.max_tokens,
        timeout=settings.describe_timeout,
        # The OpenAI client retries twice by default, so one call is really
        # three attempts and `describe_timeout` is effectively tripled — a 60s
        # budget becomes 180s, long after the user gave up on the button. A
        # description is not worth a transport-level retry; they can press it
        # again.
        max_retries=0,
        # Off by default. Reasoning tokens come out of `max_tokens`, so a model
        # that deliberates returns empty content and the button appears to hang.
        **reasoning_kwargs(settings.reasoning_effort, settings.reasoning_max_tokens),
    )


async def describe_scenario(
    request: DescribeScenarioRequest,
    *,
    model: Any | None = None,
) -> str:
    """Generate a scenario description.

    Args:
        request: Scenario name and per-track digests.
        model: Injected chat model. Production passes None and one is built
            from settings; tests pass a fake.

    Returns:
        Cleaned prose, ready to drop into the panel's textarea for review.

    Raises:
        ValueError: The model returned no usable content. Reasoning-variant
            models can emit only reasoning tokens and no content at all, which
            is otherwise silent — the caller turns this into a readable 502.
    """
    chat = model if model is not None else _build_model()

    response = await chat.ainvoke(
        [
            SystemMessage(content=SYSTEM_PROMPT),
            HumanMessage(content=build_describe_prompt(request)),
        ]
    )

    description = _clean(getattr(response, "content", "") or "")
    if not description:
        raise ValueError(
            "the model returned an empty description — check that "
            f"{settings.model} at {settings.llm_base_url} emits content"
        )

    return description

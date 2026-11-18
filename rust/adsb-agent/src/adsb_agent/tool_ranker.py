"""Tool ranking: bind only the tools a request is likely to need.

Every turn used to bind the whole tool surface (~40 tools). Their schemas were
about three quarters of the prompt, so a one-line question cost ~7k input
tokens. This module asks a small **decision model** one yes/no question per
tool -- "does this request need tool X?" -- in a single batched request, and
keeps the best-scoring ones.

The decision endpoint (``typesafe/v1/systemone``) takes::

    {"model": ..., "state": {...}, "questions": {<key>: {"type": "noul",
     "instructions": ..., "criteria": {"true": ..., "false": ...}}}}

and answers ``{"answers": {<key>: {"type": "noul", "noul": <0..1>}}}``. Each
question is scored independently of the others in the batch, so the wording of
one question is the whole lever on that tool's score. It lives in
:class:`QuestionWording` so the evaluation harness can vary it.

Two layers, deliberately separate:

* :func:`rank_tools` does the I/O and returns raw scores, or raises
  :class:`RankerError`.
* :func:`pick` is pure: scores in, kept tools out. The harness sweeps ``top_k``
  and the pinned set over one set of scores without calling the model again.

:func:`select_tools` is what the agent calls. It is **fail-open**: disabled,
unreachable, slow or malformed all return the full list. A broken ranker may
cost tokens; it must never cost a turn.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx

from . import metrics
from .config import settings
from .tracing import make_span

logger = logging.getLogger("adsb_agent.tool_ranker")


class RankerError(Exception):
    """The decision model could not produce a usable score for every tool."""


@dataclass(frozen=True)
class QuestionWording:
    """How one tool is put to the decision model.

    Each template is formatted with ``{name}`` and ``{description}``.
    """

    instructions: str
    true: str
    false: str

    def question(self, name: str, description: str) -> dict[str, Any]:
        fill = {"name": name, "description": description}
        return {
            "type": "noul",
            "instructions": self.instructions.format(**fill),
            "criteria": {
                "true": self.true.format(**fill),
                "false": self.false.format(**fill),
            },
        }


DEFAULT_WORDING = QuestionWording(
    instructions="Would the assistant need the tool `{name}` to fulfil the user's request?",
    true="The tool is needed. Tool description: {description}",
    false="The tool is not needed for this request.",
)


@dataclass
class Selection:
    """The outcome of one ranking decision."""

    tools: list[Any]
    """The tools to bind, in their original order."""
    scores: dict[str, float] = field(default_factory=dict)
    fallback: str | None = None
    """Why the full list was returned unranked, or None when ranking applied."""
    latency_ms: float = 0.0


def build_request(
    tools: Sequence[Any],
    question: str,
    history: Sequence[str],
    *,
    model: str,
    wording: QuestionWording = DEFAULT_WORDING,
) -> dict[str, Any]:
    """The systemone request body: one ``noul`` question per tool."""
    inputs: dict[str, Any] = {"question": question}
    if history:
        inputs["previous_requests"] = list(history)
    return {
        "model": model,
        "state": {"inputs": inputs},
        "questions": {
            t.name: wording.question(t.name, getattr(t, "description", "") or "") for t in tools
        },
    }


def _parse_scores(payload: Any, names: Iterable[str]) -> dict[str, float]:
    answers = payload.get("answers") if isinstance(payload, dict) else None
    if not isinstance(answers, dict):
        raise RankerError("response has no 'answers' object")
    scores: dict[str, float] = {}
    for name in names:
        value = (answers.get(name) or {}).get("noul")
        # bool is an int subclass, and a bare true/false is not a ranking score.
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            # An absent tool is not a low score: ranking it last would silently
            # drop it. Refuse the whole answer instead.
            raise RankerError(f"no numeric score for tool {name!r}")
        scores[name] = float(value)
    return scores


async def rank_tools(
    tools: Sequence[Any],
    question: str,
    history: Sequence[str],
    client: httpx.AsyncClient,
    *,
    url: str,
    model: str,
    timeout: float,
    wording: QuestionWording = DEFAULT_WORDING,
) -> dict[str, float]:
    """Score every tool against the request. Raises :class:`RankerError`."""
    body = build_request(tools, question, history, model=model, wording=wording)
    try:
        resp = await client.post(url, json=body, timeout=timeout)
        resp.raise_for_status()
        payload = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        # httpx.ReadTimeout stringifies to "", so always name the type.
        raise RankerError(f"{type(e).__name__}: {e}".rstrip(": ")) from e
    return _parse_scores(payload, [t.name for t in tools])


def pick(
    tools: Sequence[Any],
    scores: dict[str, float],
    *,
    top_k: int,
    pinned: Iterable[str] = (),
    already_called: Iterable[str] = (),
) -> list[Any]:
    """Keep the ``top_k`` best-scoring tools, plus the pinned and already-called ones.

    The result is in the **original** order, not score order: the tool list is
    part of the prompt prefix, and a stable order keeps as much of it stable as
    the selection allows. Ties break by original position for the same reason.
    """
    order = {t.name: i for i, t in enumerate(tools)}
    best = sorted(order, key=lambda n: (-scores.get(n, 0.0), order[n]))[: max(top_k, 0)]
    keep = set(best) | set(pinned) | set(already_called)
    return [t for t in tools if t.name in keep]


def conversation_signals(
    messages: Iterable[Any], *, max_history: int = 3
) -> tuple[str, list[str], set[str]]:
    """What to rank against, from the AG-UI messages of one run.

    Returns ``(question, history, already_called)``: the last user message, the
    few user messages before it (a follow-up such as "and now?" means nothing
    alone), and every tool name called earlier in the conversation.

    Read from the raw AG-UI messages on purpose. ``convert_agui_messages_to_lc``
    strips the agent's own backend calls from what the LLM sees, so the
    converted history would not show that a follow-up builds on, say,
    ``getTimeDistribution``.
    """
    user_texts: list[str] = []
    called: set[str] = set()
    for msg in messages:
        role = getattr(msg, "role", None)
        if role == "user":
            content = getattr(msg, "content", None)
            if isinstance(content, str) and content.strip():
                user_texts.append(content.strip())
        elif role == "assistant":
            for tc in getattr(msg, "tool_calls", None) or []:
                name = getattr(getattr(tc, "function", None), "name", None)
                if name:
                    called.add(name)
    if not user_texts:
        return "", [], called
    history = user_texts[:-1][-max_history:] if max_history > 0 else []
    return user_texts[-1], history, called


async def select_tools(
    tools: list[Any],
    messages: Iterable[Any],
    *,
    client: httpx.AsyncClient | None = None,
) -> Selection:
    """Choose the tools to bind for one run. Never raises; see module docstring."""
    if not settings.tool_ranker_enabled:
        return Selection(tools=tools, fallback="disabled")

    question, history, called = conversation_signals(messages)
    if not question:
        return Selection(tools=tools, fallback="no-question")
    if len(tools) <= settings.tool_ranker_top_k:
        return Selection(tools=tools, fallback="nothing-to-drop")

    with make_span("tool_ranker", span_type="RETRIEVER") as span:
        if span is not None:
            span.set_inputs({"question": question, "history": history, "tools": len(tools)})
        started = time.perf_counter()
        try:
            if client is None:
                async with httpx.AsyncClient() as own:
                    scores = await _rank(tools, question, history, own)
            else:
                scores = await _rank(tools, question, history, client)
        except RankerError as e:
            latency_ms = (time.perf_counter() - started) * 1000
            logger.warning("Tool ranker failed, binding all %d tools: %s", len(tools), e)
            metrics.TOOL_RANKER_DECISIONS.labels(outcome="fallback").inc()
            metrics.TOOL_RANKER_DURATION.observe(latency_ms / 1000)
            if span is not None:
                span.set_outputs({"fallback": str(e), "latency_ms": round(latency_ms, 1)})
            return Selection(tools=tools, fallback=str(e) or "error", latency_ms=latency_ms)

        latency_ms = (time.perf_counter() - started) * 1000
        selected = pick(
            tools,
            scores,
            top_k=settings.tool_ranker_top_k,
            pinned=settings.tool_ranker_pinned,
            already_called=called,
        )
        metrics.TOOL_RANKER_DECISIONS.labels(outcome="ranked").inc()
        metrics.TOOL_RANKER_DURATION.observe(latency_ms / 1000)
        metrics.TOOL_RANKER_TOOLS_BOUND.observe(len(selected))
        if span is not None:
            span.set_outputs(
                {
                    "selected": [t.name for t in selected],
                    "dropped": len(tools) - len(selected),
                    "scores": {k: round(v, 3) for k, v in scores.items()},
                    "latency_ms": round(latency_ms, 1),
                }
            )
        return Selection(tools=selected, scores=scores, latency_ms=latency_ms)


async def _rank(
    tools: Sequence[Any], question: str, history: Sequence[str], client: httpx.AsyncClient
) -> dict[str, float]:
    return await rank_tools(
        tools,
        question,
        history,
        client,
        url=settings.tool_ranker_url,
        model=settings.tool_ranker_model,
        timeout=settings.tool_ranker_timeout,
    )

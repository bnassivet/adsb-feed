"""Desktop fast path: a small model carries out direct display commands.

"Switch to night mode" does not need the main agent. Its ~7k-token prompt and
second model call cost seconds for something a 3B model does in a fraction of
one. Before the main agent runs, a new user request goes through three checks::

    request -> embedding gate -> veto (decision model) -> executor -> tool call
                   | no             | no                    | declines / invalid
                   +----------------+-----------------------+--> main agent

* **Embedding gate.** The request must be closer to a direct display tool
  (:data:`DIRECT_TOOLS`) than to any other tool, by ``fast_path_embed_threshold``.
* **Veto.** One ``choice`` question to the decision model: what kind of message
  is this? Embeddings match by topic ("pan to the selected aircraft" sits next
  to ``panMapTo``); the veto asks whether it is a self-contained command.
* **Executor.** A small model holding only the direct tools and
  :data:`HANDOFF`. Its calls are forwarded only if every one names a direct tool
  with schema-valid arguments.

The calls go to the browser with ids starting :data:`CALL_ID_PREFIX`. The
desktop executes them and re-runs the agent with the results; that closing run
is recognised by the prefix (:func:`is_fast_path_closing`) and answered with a
fixed confirmation, without a model.

**Fail-open.** Disabled, an unreachable or slow endpoint, a malformed reply:
:func:`try_fast_path` returns "not handled" and the main agent takes the
request exactly as it did before this module existed. It never raises.

The gate and the executor read rewritten tool descriptions
(``fast_path_descriptions.json``) that say what users type and which argument
it maps to. The main agent keeps the desktop's own descriptions: the rewrite
did not change its tool choice and would add ~680 tokens to every turn.

Measured in ``eval/fastpath_agent/FAST_PATH_EXPERIMENT.md``. The eval scripts import the
constants below, so what is evaluated is what runs.
"""

from __future__ import annotations

import copy
import json
import logging
import math
import re
import time
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx

from . import metrics
from .config import settings
from .tool_ranker import conversation_signals
from .tracing import make_span

logger = logging.getLogger("adsb_agent.fast_path")

#: Browser-side tools that set UI state in one call, with no lookup first.
#: Not here on purpose: simulation (runs in the agent), scenario and event
#: mutations (persisted, and usually need an id looked up first).
DIRECT_TOOLS = frozenset(
    {
        "setMapTheme",
        "toggleSidebar",
        "setActiveMode",
        "setLayerVisibility",
        "setHistoryWindow",
        "setColorMode",
        "setDensityConfig",
        "setEventFilter",
        "setWeatherLayer",
        "setFilters",
        "panMapTo",
        "selectAircraft",
        "toggleDemoFlights",
        "startFeed",
        "stopFeed",
    }
)

CALL_ID_PREFIX = "fp-"

# Prefixes embeddinggemma expects for a query and for a document.
QUERY_PREFIX = "task: search result | query: "
DOC_PREFIX = "title: none | text: "

HANDOFF = "handOffToAgent"
HANDOFF_TOOL = {
    "type": "function",
    "function": {
        "name": HANDOFF,
        "description": (
            "Pass the request to the full assistant. Use this for ANYTHING that is not a "
            "direct display command you can complete with exactly one of the other tools: "
            "questions, requests for information or statistics, simulating aircraft, "
            "scenarios, events, anything that needs looking something up first or several "
            "steps, and whenever you are unsure."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {"type": "string", "description": "Why this needs the full assistant"}
            },
            "required": [],
        },
    },
}

SYSTEM_PROMPT = (
    "You control the display of an aircraft-tracking map application. "
    "If the user's message is a direct display command that one of your tools carries "
    "out, call that tool. For everything else call handOffToAgent. "
    "Never answer in text and never guess: always call exactly one tool."
)

# The veto question. A ``choice``, not a yes/no: on the decision model a yes/no
# "is this a question?" scored 0.00-0.30 on obvious questions.
APP = "sent to an aircraft-tracking map application"
COMMAND = "display_command"
NOT_COMMANDS = {
    "question": (
        "A question or a request for information, a count, a list, a description or statistics."
    ),
    "simulation": (
        "A request to simulate, generate or create aircraft, trajectories, scenarios or "
        "events, or to edit or delete them."
    ),
    "other": "A greeting, small talk, or anything else.",
}
KIND_COMMAND = (
    "An instruction to change what the map or screen displays: show or hide a layer, set a "
    "filter or a time window, switch theme or mode, open or close a panel, move the map, "
    "select an aircraft, start or stop the feed."
)
KIND_QUESTION = {
    "type": "choice",
    "instructions": f"What kind of message is this, {APP}?",
    "criteria": {COMMAND: KIND_COMMAND, **NOT_COMMANDS},
}


class FastPathError(Exception):
    """A fast-path endpoint failed or answered something unusable."""


@dataclass
class FastPathDecision:
    """What the fast path decided for one run.

    ``calls`` is set only when ``reason == "handled"``; otherwise the main agent
    takes the request. The other fields are for the trace and the evaluation.
    """

    calls: list[dict] | None
    reason: str
    margin: float | None = None
    command: float | None = None
    timings_ms: dict[str, float] = field(default_factory=dict)


# --------------------------------------------------------------------------
# Tool descriptions
# --------------------------------------------------------------------------


@cache
def descriptions() -> dict[str, dict]:
    """The packaged rewrites: ``{tool: {"description", "params": {name: text}}}``."""
    raw = json.loads(Path(__file__).with_name("fast_path_descriptions.json").read_text())
    return {name: value for name, value in raw.items() if not name.startswith("_")}


def with_descriptions(tools: Iterable[Any]) -> list[SimpleNamespace]:
    """Copies of ``tools`` carrying the rewritten descriptions where there is one."""
    out = []
    for tool in tools:
        override = descriptions().get(tool.name, {})
        parameters = copy.deepcopy(getattr(tool, "parameters", None) or {})
        properties = parameters.get("properties") or {}
        for param, text in (override.get("params") or {}).items():
            if param in properties:  # the desktop may have renamed or dropped it
                properties[param]["description"] = text
        out.append(
            SimpleNamespace(
                name=tool.name,
                description=override.get("description", getattr(tool, "description", "") or ""),
                parameters=parameters,
            )
        )
    return out


# --------------------------------------------------------------------------
# Embedding gate
# --------------------------------------------------------------------------

_vectors: dict[tuple[str, str], list[float]] = {}


def clear_vector_cache() -> None:
    _vectors.clear()


#: Tool descriptions are embedded once per process, about forty in one request,
#: possibly while the embedding model is still loading. The per-request gate
#: timeout is too short for that; a failure here would repeat on every run.
DOCUMENTS_TIMEOUT = 20.0


async def _embed_batch(
    texts: Sequence[str], client: httpx.AsyncClient, timeout: float
) -> list[list[float]]:
    payload = await _post(
        client,
        settings.fast_path_embed_url,
        {"model": settings.fast_path_embed_model, "input": list(texts)},
        timeout,
    )
    try:
        vectors = [item["embedding"] for item in payload["data"]]
    except (KeyError, TypeError) as e:
        raise FastPathError(f"embedding reply: {e!r}") from e
    if len(vectors) != len(texts):
        raise FastPathError("embedding reply: wrong number of vectors")
    return vectors


async def _embed_documents(texts: Sequence[str], client: httpx.AsyncClient) -> list[list[float]]:
    """Vectors of tool descriptions, cached for the life of the process."""
    model = settings.fast_path_embed_model
    missing = [t for t in dict.fromkeys(texts) if (model, t) not in _vectors]
    if missing:
        vectors = await _embed_batch(missing, client, DOCUMENTS_TIMEOUT)
        _vectors.update({(model, t): v for t, v in zip(missing, vectors, strict=True)})
    return [_vectors[(model, t)] for t in texts]


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


async def embed_margin(
    question: str, history: Sequence[str], tools: Sequence[Any], client: httpx.AsyncClient
) -> float:
    """Best direct tool minus best other tool, by embedding similarity.

    ``tools`` already carry the descriptions to match against. With no other
    tool to compare with, the margin is the best direct similarity itself.
    """
    tool_vecs = await _embed_documents([DOC_PREFIX + t.description for t in tools], client)
    query = QUERY_PREFIX + " ".join([*history, question])
    (query_vec,) = await _embed_batch([query], client, settings.fast_path_gate_timeout)
    direct, other = [], []
    for tool, vec in zip(tools, tool_vecs, strict=True):
        (direct if tool.name in DIRECT_TOOLS else other).append(_cosine(query_vec, vec))
    return max(direct) - (max(other) if other else 0.0)


# --------------------------------------------------------------------------
# Question form
# --------------------------------------------------------------------------

#: A question word or auxiliary first, a "?" last, or a negation first. Not
#: tuned past its first measurement (2026-11-18); a change here needs the
#: development sets rerun with eval/fastpath_agent/eval_gate_variants.py.
_QUESTION_FORM = re.compile(
    r"^(what|which|why|how|where|when|who|is|are|am|was|were|do|does|did|should|could"
    r"|would|will|has|have|can)\b|\?\s*$|^(don'?t|do not|never)\b",
    re.IGNORECASE,
)


def reads_as_question(text: str) -> bool:
    """Whether the message asks something or forbids something rather than
    commanding a change. Embeddings cannot tell: "is the sidebar open?" sits
    next to the sidebar command."""
    return bool(_QUESTION_FORM.search(text.strip()))


# --------------------------------------------------------------------------
# Veto
# --------------------------------------------------------------------------


def state_text(question: str, history: Sequence[str]) -> str:
    """The request as plain text; earlier requests are labelled as such."""
    if not history:
        return question
    return "\n".join([*(f"Earlier message: {h}" for h in history), f"Latest message: {question}"])


async def command_probability(
    question: str, history: Sequence[str], client: httpx.AsyncClient
) -> float:
    """The decision model's probability that the request is a display command."""
    payload = await _post(
        client,
        settings.tool_ranker_url,
        {
            "model": settings.tool_ranker_model,
            "state": state_text(question, history),
            "questions": {"kind": KIND_QUESTION},
        },
        settings.fast_path_gate_timeout,
    )
    try:
        return float(payload["answers"]["kind"]["probabilities"][COMMAND])
    except (KeyError, TypeError, ValueError) as e:
        raise FastPathError(f"decision reply: {e!r}") from e


# --------------------------------------------------------------------------
# Executor
# --------------------------------------------------------------------------

_TYPES = {
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "object": dict,
    "array": list,
}


def args_valid(args: dict, schema: dict | None) -> bool:
    """Required fields present, no unknown fields, enums and basic types respected."""
    schema = schema or {}
    properties = schema.get("properties") or {}
    if any(name not in args for name in schema.get("required") or []):
        return False
    for name, value in args.items():
        spec = properties.get(name)
        if spec is None:
            return False
        if "enum" in spec and value not in spec["enum"]:
            return False
        expected = _TYPES.get(spec.get("type"))
        if expected and (isinstance(value, bool) and spec.get("type") != "boolean"):
            return False
        if expected and not isinstance(value, expected):
            return False
    return True


def executor_messages(question: str, history: Sequence[str]) -> list[dict]:
    """Earlier requests alternate with a stand-in assistant turn: Mistral's chat
    template rejects two user messages in a row (HTTP 500)."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for earlier in history:
        messages.append({"role": "user", "content": earlier})
        messages.append({"role": "assistant", "content": "Done."})
    messages.append({"role": "user", "content": question})
    return messages


async def run_executor(
    question: str, history: Sequence[str], direct: Sequence[Any], client: httpx.AsyncClient
) -> list[dict]:
    """The small model's tool calls, as ``[{"name", "args"}]`` (empty: it answered in text)."""
    body: dict[str, Any] = {
        "model": settings.fast_path_model,
        "temperature": 0,
        "max_tokens": 400,
        "messages": executor_messages(question, history),
        "tools": [
            *(
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters or {"type": "object", "properties": {}},
                    },
                }
                for t in direct
            ),
            HANDOFF_TOOL,
        ],
        # Said explicitly: some servers stream unless told not to.
        "stream": False,
    }
    if settings.fast_path_reasoning_effort:
        body["reasoning_effort"] = settings.fast_path_reasoning_effort
    payload = await _post(
        client,
        f"{settings.fast_path_base_url.rstrip('/')}/chat/completions",
        body,
        settings.fast_path_executor_timeout,
        headers={"Authorization": f"Bearer {settings.fast_path_api_key}"},
    )
    try:
        raw_calls = payload["choices"][0]["message"].get("tool_calls") or []
        calls = []
        for tc in raw_calls:
            arguments = tc["function"].get("arguments") or "{}"
            parsed = json.loads(arguments) if isinstance(arguments, str) else arguments
            calls.append({"name": tc["function"]["name"], "args": parsed})
    except (KeyError, IndexError, TypeError, AttributeError, json.JSONDecodeError) as e:
        raise FastPathError(f"executor reply: {e!r}") from e
    return calls


def judge_calls(calls: Sequence[dict], direct: Sequence[Any]) -> str:
    """``handled`` if every call can be forwarded as is, else why not."""
    if not calls or any(c["name"] == HANDOFF for c in calls):
        return "declined"  # a text reply is forwarded to the agent like a hand-off
    schemas = {t.name: t.parameters for t in direct}
    for call in calls:
        if call["name"] not in schemas or not isinstance(call["args"], dict):
            return "invalid"
        if not args_valid(call["args"], schemas[call["name"]]):
            return "invalid"
    return "handled"


# --------------------------------------------------------------------------
# One run
# --------------------------------------------------------------------------


async def _post(
    client: httpx.AsyncClient,
    url: str,
    body: dict,
    timeout: float,
    headers: dict[str, str] | None = None,
) -> dict:
    try:
        resp = await client.post(url, json=body, timeout=timeout, headers=headers)
        resp.raise_for_status()
        payload = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        raise FastPathError(f"{url}: {type(e).__name__}: {e}") from e
    if not isinstance(payload, dict):
        raise FastPathError(f"{url}: reply is not an object")
    return payload


def _precheck(messages: Sequence[Any], tools: Sequence[Any]) -> str | None:
    """Why this run is not a candidate, without calling anything; None if it is."""
    if not settings.fast_path_enabled:
        return "disabled"
    if not messages or getattr(messages[-1], "role", None) != "user":
        # A run continuing a tool call belongs to whoever made the call.
        has_user = any(getattr(m, "role", None) == "user" for m in messages)
        return "not-a-new-request" if has_user else "no-question"
    if not any(t.name in DIRECT_TOOLS for t in tools):
        return "no-direct-tools"
    return None


async def try_fast_path(
    messages: Iterable[Any],
    tools: Iterable[Any] | None,
    *,
    client: httpx.AsyncClient | None = None,
) -> FastPathDecision:
    """Decide one run. Never raises; anything but ``handled`` means "main agent"."""
    messages = list(messages)
    tools = list(tools or [])
    skipped = _precheck(messages, tools)
    if skipped:
        return FastPathDecision(None, skipped)
    question, history, _ = conversation_signals(messages)
    if not question:
        return FastPathDecision(None, "no-question")

    decision = FastPathDecision(None, "error")
    with make_span("fast_path", span_type="CHAIN") as span:
        if span is not None:
            span.set_inputs({"question": question, "history": history})
        try:
            if client is None:
                async with httpx.AsyncClient() as own:
                    await _decide(decision, question, history, tools, own)
            else:
                await _decide(decision, question, history, tools, client)
        except FastPathError as e:
            decision.calls, decision.reason = None, "error"
            logger.warning("Fast path failed, handing the request to the agent: %s", e)
        except Exception:  # noqa: BLE001 - the fast path must never cost a turn
            decision.calls, decision.reason = None, "error"
            logger.exception("Fast path crashed, handing the request to the agent")
        metrics.FAST_PATH_DECISIONS.labels(outcome=decision.reason).inc()
        for stage, ms in decision.timings_ms.items():
            metrics.FAST_PATH_DURATION.labels(stage=stage).observe(ms / 1000)
        if span is not None:
            span.set_outputs(
                {
                    "reason": decision.reason,
                    "margin": decision.margin,
                    "command_probability": decision.command,
                    "calls": decision.calls,
                    "timings_ms": {k: round(v, 1) for k, v in decision.timings_ms.items()},
                }
            )
    return decision


async def _decide(
    decision: FastPathDecision,
    question: str,
    history: Sequence[str],
    tools: Sequence[Any],
    client: httpx.AsyncClient,
) -> None:
    if settings.fast_path_question_check_enabled and reads_as_question(question):
        decision.reason = "question_form"
        return

    described = with_descriptions(tools)
    direct = [t for t in described if t.name in DIRECT_TOOLS]

    started = time.perf_counter()
    try:
        decision.margin = await embed_margin(question, history, described, client)
    finally:
        decision.timings_ms["embed"] = (time.perf_counter() - started) * 1000
    if decision.margin < settings.fast_path_embed_threshold:
        decision.reason = "gate_rejected"
        return

    if settings.fast_path_veto_enabled:
        started = time.perf_counter()
        try:
            decision.command = await command_probability(question, history, client)
        finally:
            decision.timings_ms["decision"] = (time.perf_counter() - started) * 1000
        if decision.command < settings.fast_path_veto_below:
            decision.reason = "vetoed"
            return

    started = time.perf_counter()
    try:
        calls = await run_executor(question, history, direct, client)
    finally:
        decision.timings_ms["executor"] = (time.perf_counter() - started) * 1000
    decision.reason = judge_calls(calls, direct)
    if decision.reason == "handled":
        decision.calls = [{**c, "id": f"{CALL_ID_PREFIX}{uuid.uuid4()}"} for c in calls]


# --------------------------------------------------------------------------
# The run after the action
# --------------------------------------------------------------------------


def _failed(content: Any) -> bool:
    if not isinstance(content, str):
        return False
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return "error" in content.lower()
    return isinstance(parsed, dict) and "error" in parsed


def is_fast_path_closing(messages: Iterable[Any]) -> bool:
    """True when this run only delivers the results of fast-path calls.

    The desktop executes a forwarded call and re-runs the agent with the
    result. If every result since the last user or assistant message belongs to
    a fast-path call and none reports a failure, the action is done and a fixed
    confirmation is enough. A failure is left to the main agent to explain.
    """
    if not settings.fast_path_enabled:
        return False
    pending = []
    for msg in reversed(list(messages)):
        if getattr(msg, "role", None) != "tool":
            break
        pending.append(msg)
    return bool(pending) and all(
        (getattr(m, "tool_call_id", "") or "").startswith(CALL_ID_PREFIX)
        and not _failed(getattr(m, "content", None))
        for m in pending
    )

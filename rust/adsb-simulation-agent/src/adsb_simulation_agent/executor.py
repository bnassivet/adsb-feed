"""A2A protocol boundary — adapts incoming tasks onto the LangGraph.

a2a-sdk v1.0 enforces a strict streaming contract on executors: either enqueue
exactly one Message and stop, *or* enqueue a Task first and then zero or more
update events. Violating it raises ``InvalidAgentResponseError``. Generation can
take a few seconds (an LLM classification hop plus geometry), so this executor
uses the Task form: Task -> artifact update -> terminal status.

Input handling is deliberately forgiving. The caller may send a structured data
part (what ``adsb-agent`` does), a text part containing JSON, or plain prose —
the last is treated as a route hint so a human poking the endpoint by hand still
gets something useful.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from a2a.helpers import new_data_artifact, new_task, new_text_message
from a2a.server.agent_execution import AgentExecutor
from a2a.types import TaskArtifactUpdateEvent, TaskState, TaskStatus, TaskStatusUpdateEvent

from .graph import generate
from .models import AircraftCategory, RoutePlan, TrajectoryRequest

logger = logging.getLogger("adsb_simulation_agent.executor")

ARTIFACT_NAME = "trajectory"

MAX_COUNT = 20
"""Mirrors ``TrajectoryRequest.count``'s schema bound."""


def _first(payload: dict[str, Any], *keys: str) -> Any:
    """First present key — lets callers use snake_case or camelCase."""
    for key in keys:
        if key in payload and payload[key] is not None:
            return payload[key]
    return None


def parse_trajectory_request(payload: dict[str, Any]) -> TrajectoryRequest:
    """Build a ``TrajectoryRequest`` from a loosely-shaped payload.

    Accepts both snake_case and camelCase because ``adsb-agent``'s LLM emits
    camelCase tool arguments. An unknown aircraft category degrades to the
    default rather than failing — but a missing or invalid origin is fatal,
    since there is nowhere to put the aircraft without one.
    """
    lat = _first(payload, "origin_lat", "originLat")
    lng = _first(payload, "origin_lng", "originLng")
    if lat is None or lng is None:
        raise ValueError("origin_lat and origin_lng are required")

    try:
        lat, lng = float(lat), float(lng)
    except (TypeError, ValueError) as e:
        raise ValueError(f"origin must be numeric: {e}") from e
    if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        raise ValueError(f"origin ({lat}, {lng}) is out of range")

    raw_category = _first(payload, "category")
    try:
        category = AircraftCategory(str(raw_category).strip().lower())
    except (ValueError, AttributeError):
        if raw_category is not None:
            logger.info("Unknown category %r; falling back to default", raw_category)
        category = AircraftCategory.GA

    count = _first(payload, "count") or 1
    try:
        count = max(1, min(int(count), MAX_COUNT))
    except (TypeError, ValueError):
        count = 1

    plan_data = _first(payload, "plan")
    plan = None
    if isinstance(plan_data, dict):
        try:
            plan = RoutePlan(**{**plan_data, "category": category})
        except Exception as e:  # noqa: BLE001 — a bad plan degrades to hint parsing
            logger.info("Ignoring unusable plan payload: %s", e)

    return TrajectoryRequest(
        origin_lat=lat,
        origin_lng=lng,
        category=category,
        count=count,
        route_hint=_first(payload, "route_hint", "routeHint"),
        plan=plan,
        cruise_altitude_ft=_first(payload, "cruise_altitude_ft", "cruiseAltitudeFt"),
        callsign_prefix=_first(payload, "callsign_prefix", "callsignPrefix"),
        seed=_first(payload, "seed"),
    )


def extract_payload(context: Any) -> dict[str, Any]:
    """Pull a request dict out of the incoming A2A message.

    Precedence: structured data part, then JSON in a text part, then plain text
    treated as a route hint.
    """
    message = getattr(context, "message", None)
    parts = list(getattr(message, "parts", []) or [])

    for part in parts:
        if part.HasField("data"):
            from a2a.helpers import get_data_parts

            data = get_data_parts([part])
            if data and isinstance(data[0], dict):
                return data[0]

    text = " ".join(p.text for p in parts if p.text).strip()
    if not text:
        return {}

    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    return {"routeHint": text}


class SimulationAgentExecutor(AgentExecutor):
    """Runs the trajectory-generation graph for one A2A task."""

    def __init__(self, llm: Any | None = None):
        self._llm = llm

    async def execute(self, context: Any, event_queue: Any) -> None:
        task_id = getattr(context, "task_id", None) or "task"
        context_id = getattr(context, "context_id", None) or "context"

        # The initial Task must be enqueued before any update event.
        await event_queue.enqueue_event(
            new_task(task_id=task_id, context_id=context_id, state=TaskState.TASK_STATE_SUBMITTED)
        )

        try:
            request = parse_trajectory_request(extract_payload(context))
        except ValueError as e:
            await self._fail(event_queue, task_id, context_id, str(e))
            return

        try:
            response = await generate(request, llm=self._llm)
        except Exception as e:
            logger.exception("Trajectory generation failed")
            await self._fail(event_queue, task_id, context_id, f"generation failed: {e}")
            return

        payload = response.model_dump(mode="json")
        # The summary travels with the data so the caller can put a compact
        # string in its LLM's context instead of hundreds of waypoints.
        payload["summary"] = response.summary()

        await event_queue.enqueue_event(
            TaskArtifactUpdateEvent(
                task_id=task_id,
                context_id=context_id,
                artifact=new_data_artifact(
                    name=ARTIFACT_NAME,
                    data=payload,
                    description="Generated aircraft trajectories with timed waypoints",
                ),
                last_chunk=True,
            )
        )
        await event_queue.enqueue_event(
            TaskStatusUpdateEvent(
                task_id=task_id,
                context_id=context_id,
                status=TaskStatus(
                    state=TaskState.TASK_STATE_COMPLETED,
                    message=new_text_message(response.summary()),
                ),
            )
        )

    async def cancel(self, context: Any, event_queue: Any) -> None:
        """Generation is a short synchronous computation — nothing to interrupt."""
        task_id = getattr(context, "task_id", None) or "task"
        context_id = getattr(context, "context_id", None) or "context"
        await event_queue.enqueue_event(
            TaskStatusUpdateEvent(
                task_id=task_id,
                context_id=context_id,
                status=TaskStatus(state=TaskState.TASK_STATE_CANCELED),
            )
        )

    async def _fail(self, event_queue: Any, task_id: str, context_id: str, reason: str) -> None:
        logger.warning("Task %s failed: %s", task_id, reason)
        await event_queue.enqueue_event(
            TaskStatusUpdateEvent(
                task_id=task_id,
                context_id=context_id,
                status=TaskStatus(
                    state=TaskState.TASK_STATE_FAILED,
                    message=new_text_message(reason),
                ),
            )
        )

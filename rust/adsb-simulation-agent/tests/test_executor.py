"""The A2A executor — protocol boundary between a2a-sdk and the LangGraph.

Two concerns kept separate so both stay testable:
* `parse_trajectory_request` / `extract_payload` — pure input handling.
* `SimulationAgentExecutor.execute` — protocol event sequencing.

a2a-sdk v1.0 enforces a strict streaming contract: enqueue a Task first, then
zero or more update events. Mixing Messages and Tasks raises
InvalidAgentResponseError, so the event order below is not stylistic.
"""

from __future__ import annotations

import pytest
from a2a.helpers import new_data_part, new_text_part
from a2a.types import Message, Role, TaskState

from adsb_simulation_agent.executor import (
    SimulationAgentExecutor,
    extract_payload,
    parse_trajectory_request,
)
from adsb_simulation_agent.models import AircraftCategory, RoutePattern

ORIGIN = {"origin_lat": 45.5, "origin_lng": -73.6}


class RecordingQueue:
    """Stands in for EventQueue, capturing what the executor emits."""

    def __init__(self):
        self.events: list = []

    async def enqueue_event(self, event):
        self.events.append(event)


class FakeContext:
    """Duck-typed RequestContext — the executor only needs these members."""

    def __init__(self, parts, task_id="task-1", context_id="ctx-1"):
        self.message = Message(message_id="msg-1", role=Role.ROLE_USER, parts=list(parts))
        self.task_id = task_id
        self.context_id = context_id
        self.current_task = None

    def get_user_input(self):
        return " ".join(p.text for p in self.message.parts if p.text)


class TestParseRequest:
    def test_reads_snake_case_fields(self):
        request = parse_trajectory_request({**ORIGIN, "category": "helicopter", "count": 2})
        assert request.category == AircraftCategory.HELICOPTER
        assert request.count == 2

    def test_reads_camel_case_fields(self):
        """adsb-agent's LLM emits camelCase tool args."""
        request = parse_trajectory_request(
            {"originLat": 45.5, "originLng": -73.6, "category": "ga", "routeHint": "orbit"}
        )
        assert request.origin_lat == 45.5
        assert request.origin_lng == -73.6
        assert request.route_hint == "orbit"

    def test_camel_case_cruise_altitude(self):
        request = parse_trajectory_request({**ORIGIN, "cruiseAltitudeFt": 4500})
        assert request.cruise_altitude_ft == 4500

    def test_category_defaults_when_absent(self):
        assert parse_trajectory_request(ORIGIN).category in set(AircraftCategory)

    def test_unknown_category_falls_back_rather_than_failing(self):
        request = parse_trajectory_request({**ORIGIN, "category": "spaceship"})
        assert request.category in set(AircraftCategory)

    def test_category_is_case_insensitive(self):
        request = parse_trajectory_request({**ORIGIN, "category": "FIGHTER"})
        assert request.category == AircraftCategory.FIGHTER

    def test_missing_origin_is_rejected(self):
        """Without an origin there is nowhere to put the aircraft."""
        with pytest.raises(ValueError, match="origin"):
            parse_trajectory_request({"category": "ga"})

    def test_out_of_range_origin_is_rejected(self):
        with pytest.raises(ValueError):
            parse_trajectory_request({"origin_lat": 999, "origin_lng": 0})

    def test_count_is_clamped_to_a_sane_maximum(self):
        request = parse_trajectory_request({**ORIGIN, "count": 5000})
        assert request.count <= 20

    def test_accepts_a_structured_plan(self):
        request = parse_trajectory_request(
            {**ORIGIN, "plan": {"pattern": "orbit", "category": "ga", "radius_nm": 3}}
        )
        assert request.plan is not None
        assert request.plan.pattern == RoutePattern.ORBIT


class TestExtractPayload:
    def test_reads_a_data_part(self):
        payload = extract_payload(FakeContext([new_data_part({**ORIGIN, "count": 2})]))
        assert payload["count"] == 2

    def test_reads_json_from_a_text_part(self):
        payload = extract_payload(FakeContext([new_text_part('{"origin_lat": 1, "count": 3}')]))
        assert payload["count"] == 3

    def test_plain_text_becomes_a_route_hint(self):
        """A human-typed request with no JSON is still usable."""
        payload = extract_payload(FakeContext([new_text_part("helicopter over downtown")]))
        assert payload["routeHint"] == "helicopter over downtown"

    def test_data_part_wins_over_text(self):
        ctx = FakeContext([new_text_part("ignored"), new_data_part({**ORIGIN, "count": 7})])
        assert extract_payload(ctx)["count"] == 7

    def test_empty_message_yields_an_empty_payload(self):
        assert extract_payload(FakeContext([])) == {}


class TestExecute:
    async def _run(self, parts):
        queue = RecordingQueue()
        await SimulationAgentExecutor(llm=None).execute(FakeContext(parts), queue)
        return queue.events

    async def test_emits_a_task_before_any_update(self):
        """v1.0 rejects update events that precede the initial Task."""
        events = await self._run([new_data_part(ORIGIN)])
        assert events
        assert type(events[0]).__name__ == "Task"

    async def test_completes_successfully(self):
        events = await self._run([new_data_part(ORIGIN)])
        states = [e.status.state for e in events if type(e).__name__ == "TaskStatusUpdateEvent"]
        assert TaskState.TASK_STATE_COMPLETED in states

    async def test_emits_the_trajectory_as_a_data_artifact(self):
        events = await self._run([new_data_part({**ORIGIN, "count": 2})])
        artifacts = [e.artifact for e in events if type(e).__name__ == "TaskArtifactUpdateEvent"]
        assert artifacts

        from a2a.helpers import get_data_parts

        payload = get_data_parts(artifacts[0].parts)[0]
        assert len(payload["aircraft"]) == 2
        assert payload["aircraft"][0]["waypoints"]

    async def test_artifact_waypoints_carry_the_expected_shape(self):
        events = await self._run([new_data_part(ORIGIN)])
        artifact = next(e.artifact for e in events if type(e).__name__ == "TaskArtifactUpdateEvent")

        from a2a.helpers import get_data_parts

        waypoint = get_data_parts(artifact.parts)[0]["aircraft"][0]["waypoints"][0]
        for field in ("lat", "lng", "alt_ft", "speed_kts", "heading_deg", "phase", "t_offset_s"):
            assert field in waypoint

    async def test_includes_the_compact_summary(self):
        """The summary is what adsb-agent puts in the LLM's ToolMessage."""
        events = await self._run([new_data_part(ORIGIN)])
        artifact = next(e.artifact for e in events if type(e).__name__ == "TaskArtifactUpdateEvent")

        from a2a.helpers import get_data_parts

        payload = get_data_parts(artifact.parts)[0]
        assert "summary" in payload
        assert "aircraft" in payload["summary"]

    async def test_honours_a_route_hint_without_an_llm(self):
        events = await self._run([new_data_part({**ORIGIN, "routeHint": "circle downtown"})])
        assert any(type(e).__name__ == "TaskArtifactUpdateEvent" for e in events)


class TestExecuteFailures:
    async def _run(self, parts):
        queue = RecordingQueue()
        await SimulationAgentExecutor(llm=None).execute(FakeContext(parts), queue)
        return queue.events

    async def test_missing_origin_fails_the_task_rather_than_raising(self):
        events = await self._run([new_data_part({"category": "ga"})])
        states = [e.status.state for e in events if type(e).__name__ == "TaskStatusUpdateEvent"]
        assert TaskState.TASK_STATE_FAILED in states

    async def test_failure_still_emits_the_task_first(self):
        events = await self._run([new_data_part({"category": "ga"})])
        assert type(events[0]).__name__ == "Task"

    async def test_failure_explains_itself(self):
        events = await self._run([new_data_part({"category": "ga"})])
        failed = next(
            e
            for e in events
            if type(e).__name__ == "TaskStatusUpdateEvent"
            and e.status.state == TaskState.TASK_STATE_FAILED
        )

        from a2a.helpers import get_message_text

        assert "origin" in get_message_text(failed.status.message).lower()

    async def test_empty_request_fails_cleanly(self):
        events = await self._run([])
        states = [e.status.state for e in events if type(e).__name__ == "TaskStatusUpdateEvent"]
        assert TaskState.TASK_STATE_FAILED in states


class TestCancel:
    async def test_cancel_is_supported_without_raising(self):
        queue = RecordingQueue()
        await SimulationAgentExecutor(llm=None).cancel(FakeContext([]), queue)

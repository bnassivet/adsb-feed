"""RUN_ERROR must terminate the run — nothing may follow it.

AG-UI treats RUN_ERROR as terminal. CopilotKit enforces that on the client and
throws:

    Cannot send event type 'RUN_FINISHED': The run has already errored with
    'RUN_ERROR'. No further events can be sent.

The trap: the agent has two error paths. Exceptions that *propagate* out of
`stream_llm_response` are caught in `_produce`, which sets `errored` and skips
RUN_FINISHED. But `llm.py` and `graph.py` also handle failures by **yielding** a
`RunErrorEvent` — no exception escapes, `errored` stays False, and RUN_FINISHED
is appended after the terminal event.
"""

from __future__ import annotations

import pytest
from ag_ui.core import (
    EventType,
    RunErrorEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)
from httpx import ASGITransport, AsyncClient

import adsb_agent.main as main_mod
from adsb_agent.main import app

BODY = {
    "threadId": "t1",
    "runId": "r1",
    "messages": [{"id": "m1", "role": "user", "content": "simulate a helicopter"}],
    "tools": [],
    "context": [],
    "state": {},
    "forwardedProps": {},
}


@pytest.fixture
def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _event_types(client: AsyncClient) -> list[str]:
    resp = await client.post("/ag-ui/chat", json=BODY)
    assert resp.status_code == 200
    types = []
    for line in resp.text.split("\n"):
        if not line.startswith("data:"):
            continue
        for name in EventType:
            if f'"{name.value}"' in line:
                types.append(name.value)
                break
    return types


class TestYieldedRunError:
    """The path that actually broke: an error event, not an exception."""

    @pytest.fixture(autouse=True)
    def _stream(self, monkeypatch):
        async def mock_stream(*_args, **_kwargs):
            yield TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START, message_id="m", role="assistant"
            )
            yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id="m")
            yield RunErrorEvent(type=EventType.RUN_ERROR, message="boom")

        monkeypatch.setattr(main_mod, "stream_llm_response", mock_stream)

    async def test_run_error_is_forwarded(self, client):
        assert "RUN_ERROR" in await _event_types(client)

    async def test_no_run_finished_after_run_error(self, client):
        assert "RUN_FINISHED" not in await _event_types(client)

    async def test_run_error_is_the_last_event(self, client):
        assert (await _event_types(client))[-1] == "RUN_ERROR"


class TestRaisedException:
    """The path that already worked — kept so the fix doesn't regress it."""

    @pytest.fixture(autouse=True)
    def _stream(self, monkeypatch):
        async def mock_stream(*_args, **_kwargs):
            yield TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START, message_id="m", role="assistant"
            )
            raise RuntimeError("exploded")

        monkeypatch.setattr(main_mod, "stream_llm_response", mock_stream)

    async def test_ends_on_run_error(self, client):
        types = await _event_types(client)
        assert types[-1] == "RUN_ERROR"
        assert "RUN_FINISHED" not in types


class TestToolCallBeforeRunError:
    """The scenario this actually happens in.

    A trajectory is generated and forwarded, then the slow local model stalls
    the narration turn and `run_graph_to_agui` reports RUN_ERROR. The tool call
    precedes the terminal event, so the aircraft still reach the map — but only
    if nothing is appended after RUN_ERROR to make the client reject the run.
    """

    @pytest.fixture(autouse=True)
    def _stream(self, monkeypatch):
        from ag_ui.core import ToolCallEndEvent, ToolCallStartEvent

        async def mock_stream(*_args, **_kwargs):
            yield ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id="tc1",
                tool_call_name="applySimulatedTrajectory",
            )
            yield ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id="tc1")
            yield RunErrorEvent(type=EventType.RUN_ERROR, message="narration stalled")

        monkeypatch.setattr(main_mod, "stream_llm_response", mock_stream)

    async def test_tool_call_survives_and_error_terminates(self, client):
        types = await _event_types(client)
        assert "TOOL_CALL_START" in types
        assert types.index("TOOL_CALL_START") < types.index("RUN_ERROR")
        assert types[-1] == "RUN_ERROR"
        assert "RUN_FINISHED" not in types


class TestSuccessfulRun:
    """A clean run must still be terminated by RUN_FINISHED."""

    @pytest.fixture(autouse=True)
    def _stream(self, monkeypatch):
        async def mock_stream(*_args, **_kwargs):
            yield TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START, message_id="m", role="assistant"
            )
            yield TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT, message_id="m", delta="hi"
            )
            yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id="m")

        monkeypatch.setattr(main_mod, "stream_llm_response", mock_stream)

    async def test_ends_on_run_finished(self, client):
        types = await _event_types(client)
        assert types[0] == "RUN_STARTED"
        assert types[-1] == "RUN_FINISHED"
        assert "RUN_ERROR" not in types


class TestToolCallsWithoutAnId:
    """A tool call missing its `id` must not kill the run.

    Symptom this guards: the chat UI showing a RUN_ERROR whose entire message
    is `'id'` — the string form of a Python `KeyError('id')`, raised by
    `tc["id"]` and surfaced verbatim through `RunErrorEvent(message=str(e))`.
    Every other field of a tool call is already read defensively (`tc.get("args",
    {})`); `id` was the one required key, and an id is the least important thing
    to fail a whole turn over — we can mint one.
    """

    def _events(self, tool_calls):
        from adsb_agent.graph import _forward_tool_calls

        return list(_forward_tool_calls(tool_calls, message_id="m1", text_started=True))

    def test_a_call_without_an_id_is_still_forwarded(self):
        events = self._events([{"name": "applySimulatedTrajectory", "args": {"aircraft": []}}])
        kinds = [type(e).__name__ for e in events]
        assert "ToolCallStartEvent" in kinds
        assert "ToolCallArgsEvent" in kinds
        assert "ToolCallEndEvent" in kinds

    def test_the_minted_id_is_the_same_across_start_args_and_end(self):
        """Three different ids would leave the frontend unable to correlate them."""
        events = self._events([{"name": "applySimulatedTrajectory", "args": {}}])
        ids = {getattr(e, "tool_call_id", None) for e in events if hasattr(e, "tool_call_id")}
        assert len(ids) == 1
        assert next(iter(ids))

    def test_a_blank_id_is_replaced_too(self):
        events = self._events([{"name": "x", "args": {}, "id": ""}])
        ids = {getattr(e, "tool_call_id") for e in events if hasattr(e, "tool_call_id")}
        assert ids != {""}
        assert len(ids) == 1

    def test_a_real_id_is_preserved(self):
        events = self._events([{"name": "x", "args": {}, "id": "abc-123"}])
        ids = {getattr(e, "tool_call_id") for e in events if hasattr(e, "tool_call_id")}
        assert ids == {"abc-123"}

    def test_distinct_calls_get_distinct_minted_ids(self):
        events = self._events([{"name": "a", "args": {}}, {"name": "b", "args": {}}])
        ids = {getattr(e, "tool_call_id") for e in events if hasattr(e, "tool_call_id")}
        assert len(ids) == 2

    def test_a_call_without_a_name_is_skipped_not_fatal(self):
        """`name` is the other required key, and just as unworthy of a crash."""
        events = self._events([{"args": {}, "id": "i1"}])
        assert not [e for e in events if type(e).__name__ == "ToolCallStartEvent"]


class TestRunErrorMessagesAreLegible:
    """A RUN_ERROR must say what failed, not just echo an exception's `str()`.

    Real case: MLflow's AI Gateway does `id=resp["id"]` on every streaming chunk
    (`gateway/providers/openai_compatible.py:114`). LM Studio emitted a chunk
    without an id, the gateway raised `KeyError('id')` and relayed it as an SSE
    error, the OpenAI SDK re-raised it as `APIError('id')`, and the chat UI
    showed a red box whose entire message was `'id'` — naming neither the LLM
    endpoint, nor the gateway, nor even that it was an upstream failure.
    """

    def test_an_api_error_names_the_llm_endpoint(self):
        from openai import APIError

        from adsb_agent.config import settings
        from adsb_agent.graph import describe_run_error

        described = describe_run_error(APIError("'id'", request=None, body=None))
        assert settings.llm_base_url in described
        assert "APIError" in described

    def test_a_bare_key_error_is_not_reported_as_a_naked_key(self):
        from adsb_agent.graph import describe_run_error

        described = describe_run_error(KeyError("id"))
        assert described != "'id'"
        assert "KeyError" in described

    def test_an_empty_message_still_names_the_type(self):
        from adsb_agent.graph import describe_run_error

        assert "RuntimeError" in describe_run_error(RuntimeError(""))

    def test_an_ordinary_error_keeps_its_message(self):
        from adsb_agent.graph import describe_run_error

        described = describe_run_error(ValueError("something specific went wrong"))
        assert "something specific went wrong" in described

    def test_a_streaming_failure_points_at_the_upstream(self):
        """So the reader looks at the gateway/model server, not at this agent."""
        from openai import APIError

        from adsb_agent.graph import describe_run_error

        described = describe_run_error(APIError("'id'", request=None, body=None)).lower()
        assert "upstream" in described or "endpoint" in described

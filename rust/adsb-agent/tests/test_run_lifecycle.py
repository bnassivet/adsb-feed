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

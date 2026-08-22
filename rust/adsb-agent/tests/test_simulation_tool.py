"""Wiring for `generateSimulatedTrajectory` — the out-of-band result channel.

The problem this solves: `run_graph_to_agui` forwards client tool calls by
reading `.tool_calls` off the *final* message in graph state. So a server-side
tool that needs to push data to the browser has two bad options —

* short-circuit to END, and the user gets an aircraft with no chat reply; or
* loop back to the agent, and the agent's reply becomes the last message so the
  synthesized call is never forwarded.

Neither works. Instead the trajectory rides a separate `pending_client_tool_calls`
state field: the `server_tools -> agent` edge stays intact so the LLM still
narrates, and `run_graph_to_agui` emits the tool call from the final values
chunk. The LLM sees only a compact summary; the waypoints never enter its
context.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest
from ag_ui.core import EventType

from adsb_agent import graph as g
from adsb_agent.a2a_client import TrajectoryResult

SIM_TOOL = "generateSimulatedTrajectory"
APPLY_TOOL = "applySimulatedTrajectory"

TRAJECTORY_DATA = {
    "aircraft": [
        {
            "hex_ident": "SIM-A1",
            "callsign": "HELI001",
            "category": "helicopter",
            "waypoints": [{"lat": 45.5, "lng": -73.6, "alt_ft": 1200} for _ in range(86)],
        }
    ],
    "violations": [],
    "summary": "1 aircraft (helicopter), 86 waypoints, 11 min",
}


def _tool(name: str):
    return SimpleNamespace(name=name, description="d", parameters={})


class _FakeGraph:
    """Mimics a compiled LangGraph: dual-mode astream of (mode, chunk)."""

    def __init__(self, steps):
        self._steps = steps

    async def astream(self, _input, stream_mode=None, config=None):
        for step in self._steps:
            yield step


class TestToolRegistration:
    def test_simulation_tool_is_server_executed(self):
        assert SIM_TOOL in g.SERVER_TOOL_NAMES

    def test_apply_tool_is_not_server_executed(self):
        """applySimulatedTrajectory runs in the browser."""
        assert APPLY_TOOL not in g.SERVER_TOOL_NAMES

    def test_partition_routes_the_pair_correctly(self):
        server, client = g.partition_tool_names([_tool(SIM_TOOL), _tool(APPLY_TOOL)])
        assert server == {SIM_TOOL}
        assert client == {APPLY_TOOL}


class TestServerToolExecution:
    async def _run(self, monkeypatch, result: TrajectoryResult, tool_calls=None):
        async def fake_call(args, client):
            return result

        monkeypatch.setattr(g, "call_simulation_agent", fake_call)
        calls = tool_calls or [{"name": SIM_TOOL, "args": {"category": "helicopter"}, "id": "tc1"}]
        async with httpx.AsyncClient() as client:
            return await g.run_server_tool_calls(calls, {SIM_TOOL}, client)

    async def test_tool_message_carries_only_the_summary(self, monkeypatch):
        """Hundreds of waypoints must never reach a 7B local model's context."""
        out = await self._run(
            monkeypatch,
            TrajectoryResult(ok=True, summary=TRAJECTORY_DATA["summary"], data=TRAJECTORY_DATA),
        )
        content = out["messages"][0].content
        assert content == TRAJECTORY_DATA["summary"]
        assert len(content) < 200
        # The giveaway that the payload leaked would be coordinates in the text.
        assert "45.5" not in content
        assert "lat" not in content

    async def test_full_payload_goes_to_the_pending_client_call(self, monkeypatch):
        out = await self._run(
            monkeypatch,
            TrajectoryResult(ok=True, summary="s", data=TRAJECTORY_DATA),
        )
        pending = out["pending_client_tool_calls"]
        assert len(pending) == 1
        assert pending[0]["name"] == APPLY_TOOL
        assert pending[0]["args"]["aircraft"][0]["callsign"] == "HELI001"
        assert len(pending[0]["args"]["aircraft"][0]["waypoints"]) == 86

    async def test_pending_call_has_an_id(self, monkeypatch):
        out = await self._run(
            monkeypatch, TrajectoryResult(ok=True, summary="s", data=TRAJECTORY_DATA)
        )
        assert out["pending_client_tool_calls"][0]["id"]

    async def test_tool_message_matches_the_originating_call_id(self, monkeypatch):
        out = await self._run(
            monkeypatch, TrajectoryResult(ok=True, summary="s", data=TRAJECTORY_DATA)
        )
        assert out["messages"][0].tool_call_id == "tc1"

    async def test_failure_reports_to_the_model_without_a_pending_call(self, monkeypatch):
        """A dead simulation agent should let the LLM explain, not push junk."""
        out = await self._run(
            monkeypatch,
            TrajectoryResult(ok=False, error="could not reach the simulation agent"),
        )
        assert "could not reach" in out["messages"][0].content
        assert out["pending_client_tool_calls"] == []

    async def test_other_server_tools_are_unaffected(self, monkeypatch):
        async def fake_exec(name, args, client):
            return '{"ok": true}'

        monkeypatch.setattr(g, "execute_server_tool", fake_exec)
        async with httpx.AsyncClient() as client:
            out = await g.run_server_tool_calls(
                [{"name": "getStorageStats", "args": {}, "id": "tc9"}],
                {"getStorageStats"},
                client,
            )
        assert out["messages"][0].content == '{"ok": true}'
        assert out["pending_client_tool_calls"] == []


class TestGraphTopology:
    def test_server_tools_still_loops_back_to_agent(self):
        """If this edge is removed the user gets an aircraft but no chat reply."""
        graph = g.build_agent_graph([_tool(SIM_TOOL)], model=SimpleNamespace())
        edges = graph.get_graph().edges
        assert any(e.source == "server_tools" and e.target == "agent" for e in edges)


class TestEventForwarding:
    async def test_pending_call_is_emitted_from_the_values_chunk(self):
        final = SimpleNamespace(tool_calls=[])
        steps = [
            (
                "values",
                {
                    "messages": [final],
                    "pending_client_tool_calls": [
                        {"name": APPLY_TOOL, "args": TRAJECTORY_DATA, "id": "p1"}
                    ],
                },
            )
        ]
        events = [e async for e in g.run_graph_to_agui(_FakeGraph(steps), [])]
        starts = [e for e in events if e.type == EventType.TOOL_CALL_START]
        assert [s.tool_call_name for s in starts] == [APPLY_TOOL]

    async def test_text_reply_and_trajectory_both_survive(self):
        """The whole point of the out-of-band channel: the user gets a chat
        reply *and* the aircraft appear."""
        final = SimpleNamespace(tool_calls=[])
        steps = [
            ("messages", (SimpleNamespace(content="Generated a helicopter orbit."), {})),
            (
                "values",
                {
                    "messages": [final],
                    "pending_client_tool_calls": [
                        {"name": APPLY_TOOL, "args": TRAJECTORY_DATA, "id": "p1"}
                    ],
                },
            ),
        ]
        events = [e async for e in g.run_graph_to_agui(_FakeGraph(steps), [])]
        types = [e.type for e in events]
        assert EventType.TEXT_MESSAGE_CONTENT in types, "chat reply was lost"
        assert EventType.TOOL_CALL_START in types, "trajectory was not forwarded"

        text = "".join(
            e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT
        )
        assert "helicopter" in text

    async def test_forwarded_args_contain_the_waypoints(self):
        final = SimpleNamespace(tool_calls=[])
        steps = [
            (
                "values",
                {
                    "messages": [final],
                    "pending_client_tool_calls": [
                        {"name": APPLY_TOOL, "args": TRAJECTORY_DATA, "id": "p1"}
                    ],
                },
            )
        ]
        events = [e async for e in g.run_graph_to_agui(_FakeGraph(steps), [])]
        args_evt = next(e for e in events if e.type == EventType.TOOL_CALL_ARGS)
        payload = json.loads(args_evt.delta)
        assert len(payload["aircraft"][0]["waypoints"]) == 86

    async def test_regular_client_tool_calls_still_forward(self):
        """No regression for the existing forwarding path."""
        final = SimpleNamespace(
            tool_calls=[{"name": "panMapTo", "args": {"latitude": 1.0}, "id": "c1"}]
        )
        events = [
            e async for e in g.run_graph_to_agui(_FakeGraph([("values", {"messages": [final]})]), [])
        ]
        starts = [e for e in events if e.type == EventType.TOOL_CALL_START]
        assert [s.tool_call_name for s in starts] == ["panMapTo"]

    async def test_both_channels_emit_together(self):
        final = SimpleNamespace(
            tool_calls=[{"name": "panMapTo", "args": {}, "id": "c1"}]
        )
        steps = [
            (
                "values",
                {
                    "messages": [final],
                    "pending_client_tool_calls": [
                        {"name": APPLY_TOOL, "args": TRAJECTORY_DATA, "id": "p1"}
                    ],
                },
            )
        ]
        events = [e async for e in g.run_graph_to_agui(_FakeGraph(steps), [])]
        names = {e.tool_call_name for e in events if e.type == EventType.TOOL_CALL_START}
        assert names == {"panMapTo", APPLY_TOOL}

    async def test_no_pending_calls_changes_nothing(self):
        final = SimpleNamespace(tool_calls=[])
        steps = [("messages", (SimpleNamespace(content="hi"), {})), ("values", {"messages": [final]})]
        events = [e async for e in g.run_graph_to_agui(_FakeGraph(steps), [])]
        assert not any(e.type == EventType.TOOL_CALL_START for e in events)


@pytest.mark.parametrize("field", ["category", "count", "routeHint", "originLat", "originLng"])
def test_tool_schema_declares_expected_parameters(field):
    from adsb_agent.tools import TOOLS

    tool = next(t for t in TOOLS if t["function"]["name"] == SIM_TOOL)
    assert field in tool["function"]["parameters"]["properties"]


def test_tool_description_asks_for_the_hint_verbatim():
    """The simulation agent owns hint interpretation; this LLM must not
    pre-structure the route."""
    from adsb_agent.tools import TOOLS

    tool = next(t for t in TOOLS if t["function"]["name"] == SIM_TOOL)
    hint = tool["function"]["parameters"]["properties"]["routeHint"]["description"].lower()
    assert "verbatim" in hint or "as the user" in hint or "user's own" in hint


class TestPayloadSurvivesErrors:
    """Regression: found by manual end-to-end, not by any unit test.

    A slow model can stall the follow-up turn after the tool ran. The graph
    then raises, and `run_graph_to_agui` used to yield RUN_ERROR and return —
    discarding a trajectory that had already been generated and paid for.
    """

    class _FailingGraph:
        def __init__(self, steps):
            self._steps = steps

        async def astream(self, _input, stream_mode=None, config=None):
            for step in self._steps:
                yield step
            raise RuntimeError("No streaming chunk received for 120.0s")

    async def test_pending_calls_are_forwarded_before_the_error(self):
        steps = [
            (
                "values",
                {
                    "messages": [SimpleNamespace(tool_calls=[])],
                    "pending_client_tool_calls": [
                        {"name": APPLY_TOOL, "args": TRAJECTORY_DATA, "id": "p1"}
                    ],
                },
            )
        ]
        events = [
            e async for e in g.run_graph_to_agui(self._FailingGraph(steps), [])
        ]
        types = [e.type for e in events]
        assert EventType.TOOL_CALL_START in types, "trajectory discarded on error"
        assert EventType.RUN_ERROR in types, "the error must still be reported"
        # The payload must arrive before the error terminates the stream.
        assert types.index(EventType.TOOL_CALL_START) < types.index(EventType.RUN_ERROR)

    async def test_forwarded_payload_is_intact(self):
        steps = [
            (
                "values",
                {
                    "messages": [SimpleNamespace(tool_calls=[])],
                    "pending_client_tool_calls": [
                        {"name": APPLY_TOOL, "args": TRAJECTORY_DATA, "id": "p1"}
                    ],
                },
            )
        ]
        events = [
            e async for e in g.run_graph_to_agui(self._FailingGraph(steps), [])
        ]
        args_evt = next(e for e in events if e.type == EventType.TOOL_CALL_ARGS)
        assert len(json.loads(args_evt.delta)["aircraft"][0]["waypoints"]) == 86

    async def test_error_without_pending_calls_is_unchanged(self):
        events = [
            e async for e in g.run_graph_to_agui(self._FailingGraph([]), [])
        ]
        assert [e.type for e in events] == [EventType.RUN_ERROR]


class TestMultiLegHints:
    """The hint must reach the simulation agent with its coordinates intact.

    Coordinates are extracted downstream, from the raw hint, and any anchor the
    simulation agent cannot corroborate against them is discarded. So a model
    that "helpfully" strips or rewrites the numbers silently costs the user
    their route — the aircraft still appear, just not where they asked.
    """

    def _hint_description(self) -> str:
        from adsb_agent.tools import TOOLS

        tool = next(t for t in TOOLS if t["function"]["name"] == SIM_TOOL)
        return tool["function"]["parameters"]["properties"]["routeHint"]["description"].lower()

    def test_the_description_demands_coordinates_be_kept(self):
        assert "coordinate" in self._hint_description()

    def test_the_description_covers_multi_leg_routes(self):
        description = self._hint_description()
        assert "leg" in description or "whole" in description

    def test_a_multi_leg_hint_passes_through_unchanged(self):
        from adsb_agent.a2a_client import build_trajectory_payload

        hint = (
            "3 fighters coming from (46.49365, -1.79214) at 10000ft, manoeuvering at "
            "high speed above ILE D'YEU (46.69154, -2.35931) going up and down between "
            "1000 and 3000 feet, then going towards (46.71161, -1.92810)"
        )
        payload = build_trajectory_payload(
            {"category": "fighter", "count": 3, "routeHint": hint,
             "originLat": 46.5, "originLng": -1.8}
        )
        assert payload["routeHint"] == hint
        assert "46.69154" in payload["routeHint"]

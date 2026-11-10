"""Server tool calls reach the UI as AG-UI tool-call events, never as text.

Regression: `stream_mode="messages"` emits messages from every node, and the
loop forwarded any content as assistant text, so each server tool's
`ToolMessage` (its raw JSON) was streamed into the reply:
`{"iso": "2026-11-10T19:11:42..."}The current time is ...`.

AG-UI's way to show a backend-executed tool is TOOL_CALL_START/ARGS/END plus
TOOL_CALL_RESULT; CopilotKit skips executing any call that already has a
result, so the desktop only renders it (a card or a chip).
"""

from __future__ import annotations

import json

from ag_ui.core import EventType
from langchain_core.messages import AIMessage, HumanMessage

from adsb_agent import graph as g

TOOL_JSON = '{"iso": "2026-11-10T19:11:42+01:00", "timezone": "CET"}'


class _FakeModel:
    """Returns queued AIMessages in order (same stub as test_tool_spans)."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0

    async def ainvoke(self, _messages):
        resp = self._responses[self.calls]
        self.calls += 1
        return resp


def _call(name: str, call_id: str, args: dict | None = None) -> dict:
    return {"name": name, "args": args or {}, "id": call_id}


async def _events(responses, monkeypatch, client_tools=()):
    async def fake_exec(name, args, client):
        return TOOL_JSON

    monkeypatch.setattr(g, "execute_server_tool", fake_exec)
    tools = [
        type("T", (), {"name": n, "description": "d", "parameters": {}})() for n in client_tools
    ]
    graph = g.build_agent_graph(tools, model=_FakeModel(responses))
    return [e async for e in g.run_graph_to_agui(graph, [HumanMessage(content="what time?")])]


def _of(events, kind):
    return [e for e in events if e.type == kind]


def _text_by_message(events) -> dict[str, str]:
    out: dict[str, str] = {}
    for e in _of(events, EventType.TEXT_MESSAGE_CONTENT):
        out[e.message_id] = out.get(e.message_id, "") + e.delta
    return out


class TestNoToolOutputInText:
    async def test_tool_json_is_never_streamed_as_assistant_text(self, monkeypatch):
        events = await _events(
            [
                AIMessage(content="Checking", tool_calls=[_call("getCurrentDateTime", "t1")]),
                AIMessage(content="It is 19:11."),
            ],
            monkeypatch,
        )
        all_text = "".join(_text_by_message(events).values())
        assert "iso" not in all_text
        assert "Checking" in all_text
        assert "It is 19:11." in all_text


class TestServerToolCallEvents:
    async def test_call_and_result_are_streamed(self, monkeypatch):
        events = await _events(
            [
                AIMessage(
                    content="Checking",
                    tool_calls=[_call("getHourlyHeatmap", "t1", {"startMs": 1, "endMs": 2})],
                ),
                AIMessage(content="Busiest at 18h."),
            ],
            monkeypatch,
        )
        (start,) = _of(events, EventType.TOOL_CALL_START)
        (args,) = _of(events, EventType.TOOL_CALL_ARGS)
        (end,) = _of(events, EventType.TOOL_CALL_END)
        (result,) = _of(events, EventType.TOOL_CALL_RESULT)

        assert start.tool_call_name == "getHourlyHeatmap"
        assert start.tool_call_id == args.tool_call_id == end.tool_call_id == "t1"
        assert json.loads(args.delta) == {"startMs": 1, "endMs": 2}
        assert result.tool_call_id == "t1"
        assert result.content == TOOL_JSON
        assert result.role == "tool"

        # The call is announced before its result, and the result before the answer.
        order = [e.type for e in events]
        assert order.index(EventType.TOOL_CALL_END) < order.index(EventType.TOOL_CALL_RESULT)
        answer_start = max(
            i for i, e in enumerate(events) if e.type == EventType.TEXT_MESSAGE_START
        )
        assert order.index(EventType.TOOL_CALL_RESULT) < answer_start

    async def test_each_agent_turn_is_its_own_message(self, monkeypatch):
        events = await _events(
            [
                AIMessage(content="Checking", tool_calls=[_call("getCurrentDateTime", "t1")]),
                AIMessage(content="It is 19:11."),
            ],
            monkeypatch,
        )
        texts = _text_by_message(events)
        assert sorted(texts.values()) == ["Checking", "It is 19:11."]
        (start,) = _of(events, EventType.TOOL_CALL_START)
        narration_id = next(m for m, t in texts.items() if t == "Checking")
        assert start.parent_message_id == narration_id

    async def test_a_turn_without_text_still_gets_an_envelope(self, monkeypatch):
        """AG-UI attaches tool calls to an assistant message."""
        events = await _events(
            [
                AIMessage(content="", tool_calls=[_call("getCurrentDateTime", "t1")]),
                AIMessage(content="It is 19:11."),
            ],
            monkeypatch,
        )
        (start,) = _of(events, EventType.TOOL_CALL_START)
        started = {e.message_id for e in _of(events, EventType.TEXT_MESSAGE_START)}
        assert start.parent_message_id in started

    async def test_text_messages_open_and_close_without_overlap(self, monkeypatch):
        events = await _events(
            [
                AIMessage(content="One", tool_calls=[_call("getCurrentDateTime", "t1")]),
                AIMessage(content="Two", tool_calls=[_call("getStorageStats", "t2")]),
                AIMessage(content="Three"),
            ],
            monkeypatch,
        )
        open_id = None
        for e in events:
            if e.type == EventType.TEXT_MESSAGE_START:
                assert open_id is None, "a text message opened while another was open"
                open_id = e.message_id
            elif e.type == EventType.TEXT_MESSAGE_CONTENT:
                assert e.message_id == open_id
            elif e.type == EventType.TEXT_MESSAGE_END:
                assert e.message_id == open_id
                open_id = None
            elif e.type in (EventType.TOOL_CALL_START, EventType.TOOL_CALL_RESULT):
                assert open_id is None, "tool events inside an open text message"
        assert open_id is None
        assert len(_of(events, EventType.TOOL_CALL_RESULT)) == 2


class TestClientCallsStillForwarded:
    async def test_client_call_after_server_call(self, monkeypatch):
        events = await _events(
            [
                AIMessage(content="", tool_calls=[_call("getCurrentDateTime", "t1")]),
                AIMessage(content="Panning.", tool_calls=[_call("panMapTo", "c1", {"lat": 1})]),
            ],
            monkeypatch,
            client_tools=["panMapTo"],
        )
        starts = {e.tool_call_name: e for e in _of(events, EventType.TOOL_CALL_START)}
        assert set(starts) == {"getCurrentDateTime", "panMapTo"}
        # Only the server call carries a result; the client call runs in the browser.
        assert [r.tool_call_id for r in _of(events, EventType.TOOL_CALL_RESULT)] == ["t1"]
        texts = _text_by_message(events)
        assert starts["panMapTo"].parent_message_id == next(
            m for m, t in texts.items() if t == "Panning."
        )

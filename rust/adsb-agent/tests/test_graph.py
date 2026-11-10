"""Tests for the LangGraph ReAct agent helpers and AG-UI event translation.

These tests avoid a live LLM/graph by exercising the pure helpers directly and
driving `run_graph_to_agui` with a fake graph object that mimics LangGraph's
dual-mode `astream` output.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest
from ag_ui.core import EventType

from adsb_agent import graph as g


# --- partition_tool_names -------------------------------------------------


def _tool(name: str):
    return SimpleNamespace(name=name, description="d", parameters={})


def test_partition_splits_server_and_client():
    tools = [
        _tool("getAircraftSummary"),
        _tool("getTrajectory"),
        _tool("panMapTo"),
        _tool("selectAircraft"),
    ]
    server, client = g.partition_tool_names(tools)
    # Backend tools are the agent's own, not the intersection with what the
    # client sent (see test_server_tools.py).
    assert server == set(g.SERVER_TOOL_NAMES)
    assert client == {"panMapTo", "selectAircraft"}


def test_partition_none_yields_full_server_surface():
    server, client = g.partition_tool_names(None)
    assert "getStorageStats" in server
    assert client == set()


# --- arg transformation ---------------------------------------------------


def test_camel_to_snake():
    assert g._camel_to_snake("startMs") == "start_ms"
    assert g._camel_to_snake("hexIdent") == "hex_ident"
    assert g._camel_to_snake("metric") == "metric"


def test_transform_server_args_keys_and_metric_value():
    out = g.transform_server_args(
        {"startMs": 1, "endMs": 2, "hexIdent": "ABC", "metric": "RawMessages"}
    )
    assert out == {
        "start_ms": 1,
        "end_ms": 2,
        "hex_ident": "ABC",
        "metric": "raw_messages",
    }


# --- execute_server_tool --------------------------------------------------


@pytest.mark.asyncio
async def test_current_datetime_resolved_locally():
    async with httpx.AsyncClient() as client:
        result = await g.execute_server_tool("getCurrentDateTime", {}, client)
    payload = json.loads(result)
    assert "epoch_ms" in payload and isinstance(payload["epoch_ms"], int)


@pytest.mark.asyncio
async def test_server_tool_ok_envelope_returns_data():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/tools/getStorageStats"
        return httpx.Response(200, json={"ok": True, "data": {"row_count": 5}})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await g.execute_server_tool("getStorageStats", {}, client)
    await client.aclose()
    assert json.loads(result) == {"row_count": 5}


@pytest.mark.asyncio
async def test_server_tool_error_envelope_returns_message():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": False, "error": "Storage not available"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await g.execute_server_tool("getStorageStats", {}, client)
    await client.aclose()
    assert "Storage not available" in result


@pytest.mark.asyncio
async def test_server_tool_transport_failure_is_caught():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await g.execute_server_tool("getStorageStats", {}, client)
    await client.aclose()
    assert "Error calling getStorageStats" in result


@pytest.mark.asyncio
async def test_server_tool_sends_transformed_args():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "data": []})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    await g.execute_server_tool("getTrajectory", {"hexIdent": "ABC", "startMs": 10}, client)
    await client.aclose()
    assert captured["body"] == {"hex_ident": "ABC", "start_ms": 10}


# --- message conversion ---------------------------------------------------


def test_convert_messages_roles():
    msgs = [
        SimpleNamespace(role="system", content="sys"),
        SimpleNamespace(role="user", content="hi"),
        SimpleNamespace(
            role="assistant",
            content="",
            tool_calls=[
                SimpleNamespace(
                    id="call_1",
                    function=SimpleNamespace(name="panMapTo", arguments='{"latitude":1}'),
                )
            ],
        ),
        SimpleNamespace(role="tool", content="result", tool_call_id="call_1"),
    ]
    lc = g.convert_agui_messages_to_lc(msgs)
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

    assert isinstance(lc[0], SystemMessage)
    assert isinstance(lc[1], HumanMessage)
    assert isinstance(lc[2], AIMessage)
    # A client tool: server tool calls are stripped (see the tests below).
    assert lc[2].tool_calls[0]["name"] == "panMapTo"
    assert lc[2].tool_calls[0]["args"] == {"latitude": 1}
    assert isinstance(lc[3], ToolMessage)
    assert lc[3].tool_call_id == "call_1"


# --- server tool calls are display-only ---------------------------------
#
# The agent streams its own tool calls to the chat (cards and chips), so they
# come back in the history of every later run. The LLM sees none of them:
# follow-ups re-query, which is cheap and gives fresh data. Same as before
# they were streamed, when they never left the agent.


def _assistant(content, *calls):
    return SimpleNamespace(
        role="assistant",
        content=content,
        tool_calls=[
            SimpleNamespace(id=cid, function=SimpleNamespace(name=name, arguments="{}"))
            for name, cid in calls
        ],
    )


def _result(cid, content="{}"):
    return SimpleNamespace(role="tool", content=content, tool_call_id=cid)


def _user(text):
    return SimpleNamespace(role="user", content=text)


def test_server_calls_and_results_are_not_replayed_to_the_llm():
    from langchain_core.messages import AIMessage, ToolMessage

    lc = g.convert_agui_messages_to_lc(
        [
            _user("what time?"),
            _assistant("Checking", ("getCurrentDateTime", "s1")),
            _result("s1", '{"iso": "2026-11-10T19:11"}'),
            _assistant("It is 19:11."),
            _user("and the date?"),
        ]
    )
    assert not any(isinstance(m, ToolMessage) for m in lc)
    ais = [m for m in lc if isinstance(m, AIMessage)]
    assert [m.content for m in ais] == ["Checking", "It is 19:11."]
    assert all(not m.tool_calls for m in ais)


def test_an_envelope_with_only_server_calls_disappears():
    from langchain_core.messages import AIMessage

    lc = g.convert_agui_messages_to_lc(
        [_user("q"), _assistant("", ("getStorageStats", "s1")), _result("s1"), _assistant("A")]
    )
    assert [m.content for m in lc if isinstance(m, AIMessage)] == ["A"]


def test_client_calls_and_results_are_kept_and_paired():
    from langchain_core.messages import AIMessage, ToolMessage

    lc = g.convert_agui_messages_to_lc(
        [_user("q"), _assistant("Panning", ("panMapTo", "c1")), _result("c1", "ok")]
    )
    (ai,) = [m for m in lc if isinstance(m, AIMessage)]
    (tool,) = [m for m in lc if isinstance(m, ToolMessage)]
    assert [tc["id"] for tc in ai.tool_calls] == ["c1"]
    assert tool.tool_call_id == "c1"


def test_mixed_message_keeps_only_its_client_call():
    from langchain_core.messages import AIMessage, ToolMessage

    lc = g.convert_agui_messages_to_lc(
        [
            _user("q"),
            _assistant("", ("getStorageStats", "s1"), ("panMapTo", "c1")),
            _result("s1"),
            _result("c1", "ok"),
        ]
    )
    (ai,) = [m for m in lc if isinstance(m, AIMessage)]
    assert [tc["name"] for tc in ai.tool_calls] == ["panMapTo"]
    assert [m.tool_call_id for m in lc if isinstance(m, ToolMessage)] == ["c1"]


# --- run_graph_to_agui ----------------------------------------------------


AGENT_META = {"langgraph_node": "agent", "langgraph_step": 1}


def _ended_with(final, pending=None):
    """The `updates` LangGraph streams at the end of a run: the server_tools
    node's out-of-band calls (if any), then the agent's final message."""
    steps = []
    if pending:
        steps.append(
            ("updates", {"server_tools": {"messages": [], "pending_client_tool_calls": pending}})
        )
    steps.append(("updates", {"agent": {"messages": [final]}}))
    return steps


class _FakeGraph:
    """Mimics a compiled LangGraph: dual-mode astream of (mode, chunk)."""

    def __init__(self, steps):
        self._steps = steps

    async def astream(self, _input, stream_mode=None, config=None):
        for step in self._steps:
            yield step


@pytest.mark.asyncio
async def test_run_graph_streams_text_then_ends():
    final = SimpleNamespace(tool_calls=[])
    steps = [
        ("messages", (SimpleNamespace(content="Hel"), AGENT_META)),
        ("messages", (SimpleNamespace(content="lo"), AGENT_META)),
        *_ended_with(final),
    ]
    events = [e async for e in g.run_graph_to_agui(_FakeGraph(steps), [])]
    types = [e.type for e in events]
    assert types == [
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
    ]
    deltas = "".join(
        e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT
    )
    assert deltas == "Hello"


@pytest.mark.asyncio
async def test_run_graph_forwards_client_tool_call():
    final = SimpleNamespace(
        tool_calls=[{"name": "panMapTo", "args": {"latitude": 1.0, "longitude": 2.0}, "id": "c1"}]
    )
    steps = [*_ended_with(final)]
    events = [e async for e in g.run_graph_to_agui(_FakeGraph(steps), [])]
    types = [e.type for e in events]
    # Empty assistant-message envelope, then the tool-call triplet.
    assert EventType.TOOL_CALL_START in types
    assert EventType.TOOL_CALL_ARGS in types
    assert EventType.TOOL_CALL_END in types
    start = next(e for e in events if e.type == EventType.TOOL_CALL_START)
    assert start.tool_call_name == "panMapTo"
    args_evt = next(e for e in events if e.type == EventType.TOOL_CALL_ARGS)
    assert json.loads(args_evt.delta) == {"latitude": 1.0, "longitude": 2.0}


@pytest.mark.asyncio
async def test_run_graph_emits_run_error_on_exception():
    class _BoomGraph:
        async def astream(self, *_a, **_k):
            raise RuntimeError("boom")
            yield  # pragma: no cover

    events = [e async for e in g.run_graph_to_agui(_BoomGraph(), [])]
    assert len(events) == 1
    assert events[0].type == EventType.RUN_ERROR
    assert "boom" in events[0].message

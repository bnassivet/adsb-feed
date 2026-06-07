"""Tests for MLflow TOOL spans — every server tool execution opens a nested
``tool.<name>`` span under the active ``chat_turn`` root, capturing the tool
name + args as inputs and the result/error as outputs.

Mocking strategy mirrors test_session_tagging.py: ``mlflow`` is injected into
``sys.modules`` so the tests never require a real MLflow server.
"""

from __future__ import annotations

import json
import sys
from unittest.mock import AsyncMock, MagicMock


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_mlflow_mock() -> MagicMock:
    """Build a minimal mlflow mock whose ``start_span`` is a sync ctx manager."""
    m = MagicMock(name="mlflow")
    span_obj = MagicMock(name="span")
    span_cm = MagicMock(name="span_cm")
    span_cm.__enter__ = MagicMock(return_value=span_obj)
    span_cm.__exit__ = MagicMock(return_value=False)
    m.start_span = MagicMock(return_value=span_cm)
    return m


def _inject(mock: MagicMock) -> None:
    sys.modules["mlflow"] = mock


def _eject() -> None:
    sys.modules.pop("mlflow", None)
    sys.modules.pop("adsb_agent.tracing", None)


def _mock_http_client(post_return=None, post_side_effect=None) -> MagicMock:
    """An httpx.AsyncClient-shaped mock with an awaitable ``post``."""
    client = MagicMock(name="httpx_client")
    if post_side_effect is not None:
        client.post = AsyncMock(side_effect=post_side_effect)
    else:
        client.post = AsyncMock(return_value=post_return)
    return client


def _envelope_response(payload: dict) -> MagicMock:
    resp = MagicMock(name="response")
    resp.raise_for_status = MagicMock()
    resp.json = MagicMock(return_value=payload)
    return resp


# ---------------------------------------------------------------------------
# Local tool — getCurrentDateTime
# ---------------------------------------------------------------------------

class TestLocalToolSpan:
    def setup_method(self):
        _eject()

    def teardown_method(self):
        _eject()

    async def test_local_tool_opens_tool_span(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", True)

        mock = _make_mlflow_mock()
        _inject(mock)

        from adsb_agent.graph import execute_server_tool

        result = await execute_server_tool("getCurrentDateTime", {}, _mock_http_client())

        # Still returns the local payload, untouched by tracing.
        parsed = json.loads(result)
        assert "iso" in parsed and "epoch_ms" in parsed

        mock.start_span.assert_called_once()
        kwargs = mock.start_span.call_args.kwargs
        assert kwargs.get("name") == "tool.getCurrentDateTime"
        assert kwargs.get("span_type") == "TOOL"

        span = mock.start_span.return_value.__enter__.return_value
        span.set_inputs.assert_called_once()
        span.set_outputs.assert_called_once()


# ---------------------------------------------------------------------------
# HTTP-proxied tool — getStorageStats
# ---------------------------------------------------------------------------

class TestProxiedToolSpan:
    def setup_method(self):
        _eject()

    def teardown_method(self):
        _eject()

    async def test_success_sets_parsed_data_as_output(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", True)

        mock = _make_mlflow_mock()
        _inject(mock)

        from adsb_agent.graph import execute_server_tool

        data = {"rows": 42}
        client = _mock_http_client(
            post_return=_envelope_response({"ok": True, "data": data})
        )

        result = await execute_server_tool("getStorageStats", {}, client)
        assert json.loads(result) == data

        mock.start_span.assert_called_once()
        kwargs = mock.start_span.call_args.kwargs
        assert kwargs.get("name") == "tool.getStorageStats"
        assert kwargs.get("span_type") == "TOOL"

        span = mock.start_span.return_value.__enter__.return_value
        span.set_inputs.assert_called_once()
        span.set_outputs.assert_called_once()

    async def test_error_path_still_spans_and_returns_error_string(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", True)

        mock = _make_mlflow_mock()
        _inject(mock)

        from adsb_agent.graph import execute_server_tool

        client = _mock_http_client(post_side_effect=RuntimeError("boom"))

        # Must not raise — tracing never changes control flow.
        result = await execute_server_tool("getStorageStats", {}, client)
        assert result.startswith("Error calling getStorageStats")

        mock.start_span.assert_called_once()
        span = mock.start_span.return_value.__enter__.return_value
        span.set_outputs.assert_called_once()


# ---------------------------------------------------------------------------
# Disabled path — no spans, correct results
# ---------------------------------------------------------------------------

class TestToolSpanDisabled:
    def setup_method(self):
        _eject()

    def teardown_method(self):
        _eject()

    async def test_disabled_creates_no_span(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", False)

        poison = MagicMock(side_effect=ImportError("must not be imported"))
        sys.modules["mlflow"] = poison  # type: ignore[assignment]

        from adsb_agent.graph import execute_server_tool

        result = await execute_server_tool("getCurrentDateTime", {}, _mock_http_client())
        parsed = json.loads(result)
        assert "iso" in parsed

        poison.start_span.assert_not_called()


# ---------------------------------------------------------------------------
# Forwarded client tool calls — run_graph_to_agui records a TOOL span per call
# ---------------------------------------------------------------------------

class _FakeMessage:
    def __init__(self, tool_calls):
        self.content = ""
        self.tool_calls = tool_calls


class _FakeGraph:
    """A graph whose ``astream`` yields a final ``values`` chunk with a client
    tool call on the last message (and no text), mirroring the END-with-tool
    path that forwards to the frontend."""

    def __init__(self, tool_calls):
        self._tool_calls = tool_calls

    async def astream(self, *args, **kwargs):
        yield "values", {"messages": [_FakeMessage(self._tool_calls)]}


class _RecordingSpan:
    def __init__(self):
        self.set_inputs = MagicMock()
        self.set_outputs = MagicMock()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _recording_make_span(names: list[str]):
    """A ``make_span`` replacement that records every span name it opens."""

    def _factory(name: str, span_type: str = "LLM"):
        names.append(name)
        return _RecordingSpan()

    return _factory


class _FakeModel:
    """A chat model stub whose ``ainvoke`` returns queued AIMessages in order."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0

    async def ainvoke(self, _messages):
        resp = self._responses[self.calls]
        self.calls += 1
        return resp


class TestNodeSpans:
    def setup_method(self):
        _eject()

    def teardown_method(self):
        _eject()

    async def test_agent_node_opens_agent_span(self, monkeypatch):
        from langchain_core.messages import AIMessage, HumanMessage

        import adsb_agent.graph as g

        names: list[str] = []
        monkeypatch.setattr(g, "make_span", _recording_make_span(names))

        # Single LLM turn, no tool calls → just an "agent" span.
        model = _FakeModel([AIMessage(content="hello")])
        graph = g.build_agent_graph(None, model=model)
        await graph.ainvoke({"messages": [HumanMessage(content="hi")]})

        assert "agent" in names
        assert "server_tools" not in names

    async def test_server_tools_node_opens_span_with_nested_tool(self, monkeypatch):
        from langchain_core.messages import AIMessage, HumanMessage

        import adsb_agent.graph as g

        names: list[str] = []
        monkeypatch.setattr(g, "make_span", _recording_make_span(names))

        # execute_server_tool is the real function; its own span uses the patched
        # make_span too, so we record "tool.<name>" without hitting HTTP.
        async def fake_exec(name, args, client):
            with g.make_span(f"tool.{name}", span_type="TOOL"):
                return json.dumps({"ok": True})

        monkeypatch.setattr(g, "execute_server_tool", fake_exec)

        tc = {"name": "getStorageStats", "args": {}, "id": "t1"}
        model = _FakeModel([
            AIMessage(content="", tool_calls=[tc]),  # first: request server tool
            AIMessage(content="done"),               # then: final answer
        ])
        graph = g.build_agent_graph(None, model=model)
        await graph.ainvoke({"messages": [HumanMessage(content="how many?")]})

        assert "agent" in names
        assert "server_tools" in names
        assert "tool.getStorageStats" in names


class TestForwardedClientToolSpan:
    def setup_method(self):
        _eject()

    def teardown_method(self):
        _eject()

    async def test_forwarded_call_opens_tool_span(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", True)

        mock = _make_mlflow_mock()
        _inject(mock)

        from adsb_agent.graph import run_graph_to_agui

        graph = _FakeGraph([{"id": "c1", "name": "focusAircraft", "args": {"hex": "abc"}}])
        # Drain the generator so the forwarding loop runs.
        events = [e async for e in run_graph_to_agui(graph, [])]
        assert events  # tool-call events were forwarded

        mock.start_span.assert_called_once()
        kwargs = mock.start_span.call_args.kwargs
        assert kwargs.get("name") == "tool.focusAircraft"
        assert kwargs.get("span_type") == "TOOL"

        span = mock.start_span.return_value.__enter__.return_value
        span.set_inputs.assert_called_once()
        span.set_outputs.assert_called_once()

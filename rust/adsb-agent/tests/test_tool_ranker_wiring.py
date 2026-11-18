"""The ranker's selection must reach both the bound tools and the prompt.

Binding ten tools while the system prompt still advertises forty would invite
calls to tools the model cannot make. Both are driven by one selection, made
once per run in ``stream_llm_response``.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from adsb_agent import llm
from adsb_agent.graph import build_agent_graph
from adsb_agent.server_tools import SERVER_TOOL_NAMES, effective_tools
from adsb_agent.system_prompt import render_system_prompt
from adsb_agent.tool_ranker import Selection


def _tool(name: str, description: str) -> SimpleNamespace:
    return SimpleNamespace(name=name, description=description, parameters={})


CLIENT_TOOLS = [
    _tool("panMapTo", "Pan the map to a position."),
    _tool("setMapTheme", "Switch the map between light and dark."),
]


class _RecordingChatModel:
    """Stands in for ChatOpenAI; records what was bound."""

    bound: list[dict] | None = None

    def __init__(self, **_kw):
        pass

    def bind_tools(self, schemas):
        type(self).bound = schemas
        return self


@pytest.fixture
def chat_model(monkeypatch):
    import langchain_openai

    _RecordingChatModel.bound = None
    monkeypatch.setattr(langchain_openai, "ChatOpenAI", _RecordingChatModel)
    return _RecordingChatModel


def _bound_names(model) -> list[str]:
    return [s["function"]["name"] for s in model.bound]


class TestBuildAgentGraph:
    def test_binds_every_tool_by_default(self, chat_model):
        build_agent_graph(CLIENT_TOOLS)
        assert _bound_names(chat_model) == [t.name for t in effective_tools(CLIENT_TOOLS)]

    def test_binds_only_the_selection(self, chat_model):
        keep = {"getTrajectory", "panMapTo"}
        selection = [t for t in effective_tools(CLIENT_TOOLS) if t.name in keep]
        build_agent_graph(CLIENT_TOOLS, bound_tools=selection)
        assert _bound_names(chat_model) == ["getTrajectory", "panMapTo"]


class TestRenderSystemPrompt:
    def test_lists_only_the_selection(self):
        prompt = render_system_prompt(CLIENT_TOOLS, bound_tools=[CLIENT_TOOLS[0]])
        capabilities = prompt.split("## What you can do")[1].split("## Data conventions")[0]
        assert "Pan the map to a position." in capabilities
        assert "Switch the map between light and dark." not in capabilities

    def test_default_is_unchanged(self):
        assert render_system_prompt(CLIENT_TOOLS, bound_tools=None) == render_system_prompt(
            CLIENT_TOOLS
        )


class TestStreamLlmResponse:
    """One selection per run, handed to both the prompt and the graph."""

    @pytest.fixture
    def captured(self, monkeypatch):
        seen: dict = {}

        def fake_render(tools, context=None, *, bound_tools=None):
            seen["prompt_bound"] = bound_tools
            return "SYSTEM"

        def fake_build(tools, *, model=None, bound_tools=None):
            seen["graph_bound"] = bound_tools
            return object()

        async def fake_run(graph, lc_messages):
            return
            yield  # pragma: no cover - makes this an async generator

        monkeypatch.setattr(llm, "render_system_prompt", fake_render)
        monkeypatch.setattr(llm, "build_agent_graph", fake_build)
        monkeypatch.setattr(llm, "run_graph_to_agui", fake_run)
        return seen

    async def _run(self):
        messages = [SimpleNamespace(role="user", content="where is it?")]
        return [e async for e in llm.stream_llm_response(messages, CLIENT_TOOLS)]

    async def test_selection_reaches_prompt_and_graph(self, captured, monkeypatch):
        chosen = [CLIENT_TOOLS[0]]

        async def fake_select(tools, messages, **_kw):
            captured["ranked"] = [t.name for t in tools]
            return Selection(tools=chosen, scores={"panMapTo": 0.9})

        monkeypatch.setattr(llm, "select_tools", fake_select)
        await self._run()
        assert captured["prompt_bound"] is chosen
        assert captured["graph_bound"] is chosen

    async def test_ranks_the_whole_surface_backend_tools_included(self, captured, monkeypatch):
        async def fake_select(tools, messages, **_kw):
            captured["ranked"] = {t.name for t in tools}
            return Selection(tools=tools, fallback="disabled")

        monkeypatch.setattr(llm, "select_tools", fake_select)
        await self._run()
        assert captured["ranked"] >= SERVER_TOOL_NAMES | {"panMapTo", "setMapTheme"}

    async def test_fallback_takes_todays_path_exactly(self, captured, monkeypatch):
        """No selection is passed at all, so nothing downstream can differ."""

        async def fake_select(tools, messages, **_kw):
            return Selection(tools=tools, fallback="ReadTimeout")

        monkeypatch.setattr(llm, "select_tools", fake_select)
        await self._run()
        assert captured["prompt_bound"] is None
        assert captured["graph_bound"] is None


def test_ranker_is_off_by_default(monkeypatch):
    from adsb_agent.config import Settings

    monkeypatch.delenv("ADSB_AGENT_TOOL_RANKER_ENABLED", raising=False)
    assert Settings(_env_file=None).tool_ranker_enabled is False

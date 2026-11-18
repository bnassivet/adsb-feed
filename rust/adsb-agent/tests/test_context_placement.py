"""Where the ambient UI state goes in the prompt.

The model server reuses the previous prompt only up to the first character that
differs. UI state (track count, selection, layers) changes between turns, so
when it sits near the top of the system prompt every turn reprocesses the whole
prompt: 17 s to first token against 0.4 s (eval/cache_experiment.py).

With ``context_placement = "user"`` the system prompt carries nothing that
changes between turns, and the state rides on the latest user message instead.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from adsb_agent import llm
from adsb_agent.config import settings
from adsb_agent.system_prompt import attach_context
from adsb_agent.tool_ranker import Selection


def _ctx(description: str, value: str) -> SimpleNamespace:
    return SimpleNamespace(description=description, value=value)


def _tool(name: str, description: str) -> SimpleNamespace:
    return SimpleNamespace(name=name, description=description, parameters={"type": "object"})


TOOLS = [_tool("panMapTo", "Pan the map to a location.")]
STATE = [_ctx("Live aircraft track count", '{"trackCount":12}')]


class TestAttachContext:
    def test_state_is_added_to_the_user_message_with_the_request_kept(self):
        out = attach_context([HumanMessage(content="zoom on the selection")], STATE)
        assert '{"trackCount":12}' in out[0].content
        assert "Live aircraft track count" in out[0].content
        assert out[0].content.endswith("zoom on the selection")

    def test_only_the_latest_user_message_carries_state(self):
        """Earlier turns must read the same on every later run, or the history
        stops being a reusable prefix."""
        history = [
            HumanMessage(content="first"),
            AIMessage(content="done"),
            HumanMessage(content="second"),
        ]
        out = attach_context(history, STATE)
        assert out[0].content == "first"
        assert out[1].content == "done"
        assert "trackCount" in out[2].content

    def test_state_stays_on_the_user_message_during_a_tool_round_trip(self):
        """A client tool result re-enters as a new run whose last message is the
        tool result; the state still belongs to the request that started it."""
        history = [
            HumanMessage(content="pan to Brest"),
            AIMessage(content="", tool_calls=[{"name": "panMapTo", "args": {}, "id": "c1"}]),
            ToolMessage(content="ok", tool_call_id="c1"),
        ]
        out = attach_context(history, STATE)
        assert "trackCount" in out[0].content
        assert out[2].content == "ok"

    def test_input_messages_are_not_modified(self):
        original = HumanMessage(content="hello")
        attach_context([original], STATE)
        assert original.content == "hello"

    @pytest.mark.parametrize("context", [None, [], [_ctx("", "x"), _ctx("empty", "  ")]])
    def test_no_usable_state_leaves_messages_alone(self, context):
        out = attach_context([HumanMessage(content="hello")], context)
        assert out[0].content == "hello"

    def test_no_user_message_leaves_messages_alone(self):
        out = attach_context([AIMessage(content="hi")], STATE)
        assert [m.content for m in out] == ["hi"]


class TestStreamLlmResponsePlacement:
    @pytest.fixture
    def sent(self, monkeypatch):
        """The messages each run hands to the graph."""
        runs: list[list] = []

        async def fake_select(tools, messages, **_kw):
            return Selection(tools=tools, fallback="disabled")

        async def fake_run(graph, lc_messages):
            runs.append(lc_messages)
            return
            yield  # pragma: no cover - makes this an async generator

        monkeypatch.setattr(llm, "select_tools", fake_select)
        monkeypatch.setattr(llm, "build_agent_graph", lambda *a, **k: object())
        monkeypatch.setattr(llm, "run_graph_to_agui", fake_run)
        return runs

    async def _run(self, context, question="how many aircraft?"):
        messages = [SimpleNamespace(role="user", content=question)]
        async for _ in llm.stream_llm_response(messages, TOOLS, context):
            pass

    async def test_user_placement_keeps_the_system_prompt_identical_across_state_changes(
        self, sent, monkeypatch
    ):
        monkeypatch.setattr(settings, "context_placement", "user")
        await self._run([_ctx("Live aircraft track count", '{"trackCount":12}')])
        await self._run([_ctx("Live aircraft track count", '{"trackCount":13}')])

        first, second = sent
        assert isinstance(first[0], SystemMessage)
        assert first[0].content == second[0].content
        assert "trackCount" not in first[0].content
        assert '{"trackCount":12}' in first[-1].content
        assert '{"trackCount":13}' in second[-1].content

    async def test_system_placement_is_the_previous_layout(self, sent, monkeypatch):
        monkeypatch.setattr(settings, "context_placement", "system")
        await self._run(STATE)

        system, user = sent[0]
        assert "Ambient context" in system.content
        assert '{"trackCount":12}' in system.content
        assert user.content == "how many aircraft?"

    async def test_user_placement_without_a_user_message_falls_back_to_the_system_prompt(
        self, sent, monkeypatch
    ):
        """State must never be silently dropped."""
        monkeypatch.setattr(settings, "context_placement", "user")
        messages = [SimpleNamespace(role="assistant", content="hello", tool_calls=None)]
        async for _ in llm.stream_llm_response(messages, TOOLS, STATE):
            pass
        assert '{"trackCount":12}' in sent[0][0].content


def test_default_placement_keeps_the_prompt_prefix_stable():
    """ "system" costs a full prompt reprocess on every UI-state change."""
    from adsb_agent.config import Settings

    assert Settings.model_fields["context_placement"].default == "user"

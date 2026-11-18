"""The fast path inside one agent run (``llm.stream_llm_response``).

Handled: the small model's calls go to the browser and the main agent is never
built. Not handled: the run is exactly what it was before the fast path. The
run that brings the results back is answered with a fixed confirmation.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from ag_ui.core import EventType

from adsb_agent import llm
from adsb_agent.config import settings
from adsb_agent.fast_path import FastPathDecision
from adsb_agent.tool_ranker import Selection

TOOLS = [
    SimpleNamespace(name="setMapTheme", description="Set the theme.", parameters={"type": "object"})
]


def user(text: str) -> SimpleNamespace:
    return SimpleNamespace(role="user", content=text)


@pytest.fixture
def main_agent(monkeypatch):
    """Records each time the main agent is built and run."""
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


def fast_path_says(monkeypatch, decision: FastPathDecision) -> list:
    seen: list = []

    async def fake(messages, tools, **_kw):
        seen.append((list(messages), tools))
        return decision

    monkeypatch.setattr(llm, "try_fast_path", fake)
    return seen


async def events(messages, tools=TOOLS):
    return [e async for e in llm.stream_llm_response(messages, tools, None)]


class TestHandled:
    @pytest.fixture(autouse=True)
    def on(self, monkeypatch):
        monkeypatch.setattr(settings, "fast_path_enabled", True)

    async def test_the_call_is_forwarded_and_the_main_agent_never_runs(
        self, monkeypatch, main_agent
    ):
        call = {"name": "setMapTheme", "args": {"theme": "dark"}, "id": "fp-1"}
        fast_path_says(monkeypatch, FastPathDecision([call], "handled"))

        out = await events([user("switch to night mode")])

        assert main_agent == []
        starts = [e for e in out if e.type == EventType.TOOL_CALL_START]
        assert [(e.tool_call_name, e.tool_call_id) for e in starts] == [("setMapTheme", "fp-1")]
        args = next(e for e in out if e.type == EventType.TOOL_CALL_ARGS)
        assert args.delta == '{"theme": "dark"}'

    async def test_the_call_hangs_on_an_assistant_message(self, monkeypatch, main_agent):
        """AG-UI pairs a tool result with its call through that message."""
        call = {"name": "setMapTheme", "args": {"theme": "dark"}, "id": "fp-1"}
        fast_path_says(monkeypatch, FastPathDecision([call], "handled"))

        out = await events([user("switch to night mode")])

        kinds = [e.type for e in out]
        assert kinds[:2] == [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_END]
        start = next(e for e in out if e.type == EventType.TOOL_CALL_START)
        assert start.parent_message_id == out[0].message_id

    @pytest.mark.parametrize(
        "reason", ["question_form", "gate_rejected", "vetoed", "declined", "invalid", "error"]
    )
    async def test_anything_else_runs_the_main_agent_as_before(
        self, monkeypatch, main_agent, reason
    ):
        fast_path_says(monkeypatch, FastPathDecision(None, reason))

        out = await events([user("how many aircraft?")])

        assert len(main_agent) == 1
        assert main_agent[0][-1].content.endswith("how many aircraft?")
        assert out == []

    async def test_it_is_given_the_same_tools_the_main_agent_gets(self, monkeypatch, main_agent):
        """Backend tools included: the gate compares against every other tool."""
        seen = fast_path_says(monkeypatch, FastPathDecision(None, "gate_rejected"))
        await events([user("hi")])
        names = {t.name for t in seen[0][1]}
        assert {"setMapTheme", "getCurrentDateTime"} <= names


class TestClosingRun:
    MESSAGES = [
        user("switch to night mode"),
        SimpleNamespace(role="tool", content='{"mapTheme":"dark"}', tool_call_id="fp-1"),
    ]

    async def test_a_fixed_confirmation_and_no_model(self, monkeypatch, main_agent):
        monkeypatch.setattr(settings, "fast_path_enabled", True)
        monkeypatch.setattr(settings, "fast_path_confirmation", "Done.")
        seen = fast_path_says(monkeypatch, FastPathDecision(None, "error"))

        out = await events(self.MESSAGES)

        assert main_agent == [] and seen == []
        assert [e.type for e in out] == [
            EventType.TEXT_MESSAGE_START,
            EventType.TEXT_MESSAGE_CONTENT,
            EventType.TEXT_MESSAGE_END,
        ]
        assert out[1].delta == "Done."

    async def test_a_failed_action_goes_to_the_main_agent(self, monkeypatch, main_agent):
        monkeypatch.setattr(settings, "fast_path_enabled", True)
        fast_path_says(monkeypatch, FastPathDecision(None, "not-a-new-request"))
        messages = [
            user("switch to night mode"),
            SimpleNamespace(role="tool", content='{"error":"boom"}', tool_call_id="fp-1"),
        ]
        await events(messages)
        assert len(main_agent) == 1


class TestDisabled:
    async def test_nothing_of_the_fast_path_runs(self, monkeypatch, main_agent):
        monkeypatch.setattr(settings, "fast_path_enabled", False)
        seen = fast_path_says(monkeypatch, FastPathDecision(None, "disabled"))

        await events([user("switch to night mode")])
        await events(TestClosingRun.MESSAGES)

        assert seen == []
        assert len(main_agent) == 2

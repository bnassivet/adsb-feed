"""Tool ranking: binding only the tools a request needs.

Every turn used to bind all ~40 tools, about three quarters of the prompt. The
ranker asks a small decision model one yes/no question per tool and keeps the
top-scoring ones. These tests pin the three things that must hold whatever the
model answers:

* the request has the shape the decision endpoint requires;
* selection is deterministic and never drops a tool the conversation depends on;
* any failure falls back to the full list -- a broken ranker must cost tokens,
  never a turn.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

from adsb_agent import tool_ranker
from adsb_agent.tool_ranker import (
    DEFAULT_WORDING,
    build_request,
    conversation_signals,
    pick,
    rank_tools,
    select_tools,
)

URL = "http://ranker.test/systemone"


def _tool(name: str, description: str = "") -> SimpleNamespace:
    return SimpleNamespace(name=name, description=description or f"Does {name}.", parameters={})


TOOLS = [_tool(n) for n in ("alpha", "bravo", "charlie", "delta", "echo")]


def _answers(scores: dict[str, float]) -> dict:
    return {
        "model": "d1-omni-600m",
        "answers": {k: {"type": "noul", "noul": v} for k, v in scores.items()},
    }


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _user(text: str) -> SimpleNamespace:
    return SimpleNamespace(role="user", content=text)


def _assistant_calling(*names: str) -> SimpleNamespace:
    return SimpleNamespace(
        role="assistant",
        content="",
        tool_calls=[
            SimpleNamespace(id=f"c-{n}", function=SimpleNamespace(name=n, arguments="{}"))
            for n in names
        ],
    )


class TestBuildRequest:
    def test_names_the_model(self):
        """The endpoint answers 400 'Missing required model parameter' without it."""
        body = build_request(TOOLS, "hi", [], model="d1-omni-600m", wording=DEFAULT_WORDING)
        assert body["model"] == "d1-omni-600m"

    def test_one_noul_question_per_tool(self):
        body = build_request(TOOLS, "hi", [], model="m", wording=DEFAULT_WORDING)
        assert list(body["questions"]) == [t.name for t in TOOLS]
        assert {q["type"] for q in body["questions"].values()} == {"noul"}

    def test_question_carries_the_tool_description(self):
        tools = [_tool("getWindAloft", "Reports the wind at an altitude.")]
        body = build_request(tools, "hi", [], model="m", wording=DEFAULT_WORDING)
        assert "Reports the wind at an altitude." in json.dumps(body["questions"]["getWindAloft"])

    def test_state_holds_the_request(self):
        body = build_request(TOOLS, "switch to night mode", [], model="m", wording=DEFAULT_WORDING)
        assert body["state"]["inputs"]["question"] == "switch to night mode"

    def test_history_is_included_only_when_present(self):
        without = build_request(TOOLS, "and now?", [], model="m", wording=DEFAULT_WORDING)
        with_ = build_request(
            TOOLS, "and now?", ["how many tracks?"], model="m", wording=DEFAULT_WORDING
        )
        assert "how many tracks?" not in json.dumps(without)
        assert "how many tracks?" in json.dumps(with_["state"])


class TestRankTools:
    async def test_returns_a_score_per_tool(self):
        scores = {"alpha": 0.9, "bravo": 0.1, "charlie": 0.5, "delta": 0.2, "echo": 0.3}
        async with _client(lambda r: httpx.Response(200, json=_answers(scores))) as c:
            got = await rank_tools(TOOLS, "q", [], c, url=URL, model="m", timeout=1.0)
        assert got == scores

    async def test_posts_to_the_configured_url(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json=_answers({t.name: 0.5 for t in TOOLS}))

        async with _client(handler) as c:
            await rank_tools(TOOLS, "q", [], c, url=URL, model="d1-omni-600m", timeout=1.0)
        assert seen["url"] == URL
        assert seen["body"]["model"] == "d1-omni-600m"

    async def test_http_error_raises(self):
        async with _client(lambda r: httpx.Response(400, json={"detail": "nope"})) as c:
            with pytest.raises(tool_ranker.RankerError):
                await rank_tools(TOOLS, "q", [], c, url=URL, model="m", timeout=1.0)

    async def test_missing_answer_raises(self):
        """A partial answer cannot be ranked: an absent tool is not a low score."""
        partial = _answers({"alpha": 0.9})
        async with _client(lambda r: httpx.Response(200, json=partial)) as c:
            with pytest.raises(tool_ranker.RankerError):
                await rank_tools(TOOLS, "q", [], c, url=URL, model="m", timeout=1.0)

    async def test_non_numeric_score_raises(self):
        bad = {"answers": {t.name: {"type": "noul", "noul": None} for t in TOOLS}}
        async with _client(lambda r: httpx.Response(200, json=bad)) as c:
            with pytest.raises(tool_ranker.RankerError):
                await rank_tools(TOOLS, "q", [], c, url=URL, model="m", timeout=1.0)


class TestPick:
    SCORES = {"alpha": 0.1, "bravo": 0.9, "charlie": 0.5, "delta": 0.8, "echo": 0.2}

    def _names(self, **kw) -> list[str]:
        return [t.name for t in pick(TOOLS, self.SCORES, **kw)]

    def test_keeps_the_top_k(self):
        assert set(self._names(top_k=2)) == {"bravo", "delta"}

    def test_preserves_the_original_order(self):
        """Not score order: a stable tool order keeps the prompt prefix stable."""
        assert self._names(top_k=3) == ["bravo", "charlie", "delta"]

    def test_pinned_tools_are_kept_on_top_of_k(self):
        assert self._names(top_k=2, pinned=["alpha"]) == ["alpha", "bravo", "delta"]

    def test_already_called_tools_are_kept(self):
        """The history references them; the follow-up turn may need them again."""
        assert self._names(top_k=1, already_called={"echo"}) == ["bravo", "echo"]

    def test_unknown_pinned_names_are_ignored(self):
        assert self._names(top_k=1, pinned=["nope"]) == ["bravo"]

    def test_ties_break_by_original_order(self):
        scores = dict.fromkeys(self.SCORES, 0.5)
        assert [t.name for t in pick(TOOLS, scores, top_k=2)] == ["alpha", "bravo"]

    def test_k_larger_than_the_list_keeps_everything(self):
        assert self._names(top_k=99) == [t.name for t in TOOLS]


class TestConversationSignals:
    def test_question_is_the_last_user_message(self):
        q, history, called = conversation_signals([_user("first"), _user("second")])
        assert q == "second"
        assert history == ["first"]
        assert called == set()

    def test_history_is_bounded(self):
        msgs = [_user(f"m{i}") for i in range(10)]
        _q, history, _ = conversation_signals(msgs, max_history=3)
        assert history == ["m6", "m7", "m8"]

    def test_collects_tools_called_earlier(self):
        msgs = [_user("where is it"), _assistant_calling("panMapTo", "getTrajectory"), _user("ok")]
        _q, _h, called = conversation_signals(msgs)
        assert called == {"panMapTo", "getTrajectory"}

    def test_no_user_message(self):
        assert conversation_signals([]) == ("", [], set())


class TestSelectTools:
    """The agent-facing entry point: settings-driven and fail-open."""

    @pytest.fixture(autouse=True)
    def _settings(self, monkeypatch):
        from adsb_agent.config import settings

        monkeypatch.setattr(settings, "tool_ranker_enabled", True)
        monkeypatch.setattr(settings, "tool_ranker_url", URL)
        monkeypatch.setattr(settings, "tool_ranker_top_k", 2)
        monkeypatch.setattr(settings, "tool_ranker_pinned", [])
        monkeypatch.setattr(settings, "mlflow_enabled", False)
        self.settings = settings

    async def test_disabled_returns_the_same_list_without_a_request(self, monkeypatch):
        monkeypatch.setattr(self.settings, "tool_ranker_enabled", False)

        def handler(request):  # pragma: no cover - must not be reached
            raise AssertionError("ranker called while disabled")

        async with _client(handler) as c:
            selection = await select_tools(TOOLS, [_user("q")], client=c)
        assert selection.tools is TOOLS
        assert selection.fallback == "disabled"

    async def test_selects_the_top_scoring_tools(self):
        scores = {"alpha": 0.1, "bravo": 0.9, "charlie": 0.5, "delta": 0.8, "echo": 0.2}
        async with _client(lambda r: httpx.Response(200, json=_answers(scores))) as c:
            selection = await select_tools(TOOLS, [_user("q")], client=c)
        assert [t.name for t in selection.tools] == ["bravo", "delta"]
        assert selection.fallback is None
        assert selection.scores == scores

    async def test_keeps_pinned_and_previously_called_tools(self, monkeypatch):
        monkeypatch.setattr(self.settings, "tool_ranker_pinned", ["alpha"])
        scores = {"alpha": 0.1, "bravo": 0.9, "charlie": 0.5, "delta": 0.8, "echo": 0.2}
        msgs = [_user("a"), _assistant_calling("echo"), _user("b")]
        async with _client(lambda r: httpx.Response(200, json=_answers(scores))) as c:
            selection = await select_tools(TOOLS, msgs, client=c)
        assert [t.name for t in selection.tools] == ["alpha", "bravo", "delta", "echo"]

    @pytest.mark.parametrize(
        "handler",
        [
            lambda r: httpx.Response(500),
            lambda r: httpx.Response(200, text="not json"),
            lambda r: httpx.Response(200, json={"answers": {}}),
            lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused")),
            lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("slow")),
        ],
        ids=["http-500", "not-json", "no-answers", "connect-error", "timeout"],
    )
    async def test_any_failure_falls_back_to_the_full_list(self, handler):
        async with _client(handler) as c:
            selection = await select_tools(TOOLS, [_user("q")], client=c)
        assert selection.tools is TOOLS
        assert selection.fallback

    async def test_no_user_message_falls_back(self):
        """Nothing to rank against: a tool-result-only run keeps every tool."""
        async with _client(lambda r: httpx.Response(200, json=_answers({}))) as c:
            selection = await select_tools(TOOLS, [], client=c)
        assert selection.tools is TOOLS
        assert selection.fallback == "no-question"

    async def test_few_tools_are_not_ranked(self):
        """At or below top_k there is nothing to drop, so skip the round trip."""

        def handler(request):  # pragma: no cover - must not be reached
            raise AssertionError("ranker called for a list it cannot shorten")

        async with _client(handler) as c:
            selection = await select_tools(TOOLS[:2], [_user("q")], client=c)
        assert selection.tools == TOOLS[:2]
        assert selection.fallback == "nothing-to-drop"


class TestMetrics:
    """Counted in Prometheus too: it must be visible when MLflow is down."""

    @pytest.fixture(autouse=True)
    def _settings(self, monkeypatch):
        from adsb_agent.config import settings

        monkeypatch.setattr(settings, "tool_ranker_enabled", True)
        monkeypatch.setattr(settings, "tool_ranker_url", URL)
        monkeypatch.setattr(settings, "tool_ranker_top_k", 2)
        monkeypatch.setattr(settings, "tool_ranker_pinned", [])
        monkeypatch.setattr(settings, "mlflow_enabled", False)

    @staticmethod
    def _count(outcome: str) -> float:
        from adsb_agent import metrics

        return metrics.TOOL_RANKER_DECISIONS.labels(outcome=outcome)._value.get()

    async def test_a_ranked_run_is_counted(self):
        before = self._count("ranked")
        scores = {t.name: 0.5 for t in TOOLS}
        async with _client(lambda r: httpx.Response(200, json=_answers(scores))) as c:
            await select_tools(TOOLS, [_user("q")], client=c)
        assert self._count("ranked") == before + 1

    async def test_a_failed_run_is_counted_as_a_fallback(self):
        before = self._count("fallback")
        async with _client(lambda r: httpx.Response(500)) as c:
            await select_tools(TOOLS, [_user("q")], client=c)
        assert self._count("fallback") == before + 1

    async def test_disabled_counts_nothing(self, monkeypatch):
        from adsb_agent.config import settings

        monkeypatch.setattr(settings, "tool_ranker_enabled", False)
        before = (self._count("ranked"), self._count("fallback"))
        await select_tools(TOOLS, [_user("q")])
        assert (self._count("ranked"), self._count("fallback")) == before

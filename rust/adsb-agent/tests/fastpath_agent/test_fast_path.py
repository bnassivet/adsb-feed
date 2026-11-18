"""The desktop fast path: gate, veto and small executor in front of the agent.

A direct display command ("switch to night mode") is carried out by a small
model in a fraction of a second instead of going through the main agent. Three
checks stand between a request and an action, and any doubt or failure sends
the request to the main agent unchanged:

  embedding gate   the request is closer to a direct tool than to any other
  veto             the decision model agrees it is a display command
  executor         the small model makes a valid call instead of handing off
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from adsb_agent import fast_path
from adsb_agent.config import settings
from adsb_agent.fast_path import (
    DIRECT_TOOLS,
    HANDOFF,
    args_valid,
    is_fast_path_closing,
    try_fast_path,
)


def _tool(name: str, description: str, properties: dict | None = None, required=()):
    return SimpleNamespace(
        name=name,
        description=description,
        parameters={
            "type": "object",
            "properties": properties or {},
            "required": list(required),
        },
    )


THEME = _tool(
    "setMapTheme",
    "Set the map theme.",
    {"theme": {"type": "string", "enum": ["light", "dark"]}},
    required=["theme"],
)
SIDEBAR = _tool("toggleSidebar", "Open or close the sidebar.", {"open": {"type": "boolean"}})
SUMMARY = _tool("getAircraftSummary", "Describe one aircraft.", {"hex": {"type": "string"}})
TOOLS = [THEME, SIDEBAR, SUMMARY]


def user(text: str) -> SimpleNamespace:
    return SimpleNamespace(role="user", content=text)


class Backend:
    """The three endpoints the fast path calls, with scripted answers."""

    def __init__(self, *, margin=0.2, command=0.9, calls=(("setMapTheme", {"theme": "dark"}),)):
        self.margin = margin
        self.command = command
        self.calls = list(calls)
        self.text = ""
        self.fail: set[str] = set()
        self.requests: dict[str, list[dict]] = {"embed": [], "decision": [], "executor": []}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        url = str(request.url)
        if "embeddings" in url:
            kind = "embed"
        elif "systemone" in url:
            kind = "decision"
        else:
            kind = "executor"
        self.requests[kind].append(body)
        if kind in self.fail:
            return httpx.Response(500, text="boom")
        if kind == "embed":
            return httpx.Response(200, json={"data": [self._vector(t) for t in body["input"]]})
        if kind == "decision":
            rest = (1 - self.command) / 3
            probabilities = {
                "display_command": self.command,
                "question": rest,
                "simulation": rest,
                "other": rest,
            }
            return httpx.Response(
                200, json={"answers": {"kind": {"type": "choice", "probabilities": probabilities}}}
            )
        message = {
            "content": self.text,
            "tool_calls": [
                {"id": f"x{i}", "function": {"name": n, "arguments": json.dumps(a)}}
                for i, (n, a) in enumerate(self.calls)
            ],
        }
        return httpx.Response(200, json={"choices": [{"message": message}]})

    def _vector(self, text: str) -> dict:
        """Unit vectors: the query scores ``margin`` on direct tools, 0 on the others."""
        if text.startswith(fast_path.QUERY_PREFIX):
            return {"embedding": [self.margin, 0.0, (1 - self.margin**2) ** 0.5]}
        is_direct = any(d in text for d in ("map theme", "sidebar", "Display command"))
        return {"embedding": [1.0, 0.0, 0.0] if is_direct else [0.0, 1.0, 0.0]}

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self))


@pytest.fixture(autouse=True)
def enabled(monkeypatch):
    monkeypatch.setattr(settings, "fast_path_enabled", True)
    monkeypatch.setattr(settings, "fast_path_veto_enabled", True)
    monkeypatch.setattr(settings, "fast_path_question_check_enabled", True)
    monkeypatch.setattr(settings, "fast_path_embed_threshold", 0.06)
    monkeypatch.setattr(settings, "fast_path_veto_below", 0.5)
    fast_path.clear_vector_cache()


async def decide(backend: Backend, messages=None, tools=TOOLS):
    async with backend.client() as client:
        return await try_fast_path(messages or [user("switch to night mode")], tools, client=client)


class TestHandled:
    async def test_a_direct_command_becomes_a_tool_call(self):
        decision = await decide(Backend())
        assert decision.reason == "handled"
        assert [(c["name"], c["args"]) for c in decision.calls] == [
            ("setMapTheme", {"theme": "dark"})
        ]

    async def test_call_ids_mark_the_fast_path(self):
        """The closing run recognises its own calls by this prefix."""
        decision = await decide(Backend())
        assert all(c["id"].startswith("fp-") for c in decision.calls)

    async def test_two_valid_calls_are_both_forwarded(self):
        backend = Backend(calls=[("setMapTheme", {"theme": "dark"}), ("toggleSidebar", {})])
        decision = await decide(backend)
        assert [c["name"] for c in decision.calls] == ["setMapTheme", "toggleSidebar"]


class TestQuestionForm:
    """Questions and negations about what a direct tool controls passed the
    embedding gate on fresh requests ("is the sidebar open?" closed it). The
    embedding matches the topic; the form of the message says it asks for no
    change. Measured 2026-11-18 on the 449 development requests: at the shipped
    threshold it stops 15 of the 20 agent requests that passed, for 1 command."""

    @pytest.mark.parametrize(
        "text",
        [
            "is the sidebar open?",
            "should I use dark mode at night?",
            "What does the density layer show",
            "which mode am I in?",
            "don't stop the feed",
            "Do not touch the labels.",
            "can you hide layers?",
            "Why is that track red?",
        ],
    )
    async def test_a_question_never_reaches_the_models(self, text):
        backend = Backend()
        decision = await decide(backend, [user(text)])
        assert (decision.calls, decision.reason) == (None, "question_form")
        assert backend.requests == {"embed": [], "decision": [], "executor": []}

    @pytest.mark.parametrize(
        "text",
        [
            "switch to night mode",
            "Show 12 hours of history.",
            "Disconnect.",
            "hide the labels",
            # starts with a question word but is an imperative
            "Canvas off",
        ],
    )
    def test_commands_do_not_read_as_questions(self, text):
        assert not fast_path.reads_as_question(text)

    def test_the_known_cost_is_a_polite_command(self):
        """It goes to the main agent: slower, never wrong."""
        assert fast_path.reads_as_question("can you go back to the light theme")

    async def test_off_lets_a_question_reach_the_gate(self, monkeypatch):
        monkeypatch.setattr(settings, "fast_path_question_check_enabled", False)
        backend = Backend()
        decision = await decide(backend, [user("is the sidebar open?")])
        assert decision.reason == "handled"
        assert backend.requests["embed"]

    async def test_only_the_latest_message_is_read(self):
        """An earlier question does not make the command after it one."""
        decision = await decide(Backend(), [user("is the feed running?"), user("Disconnect.")])
        assert decision.reason == "handled"


class TestGate:
    async def test_a_request_below_the_margin_never_reaches_the_other_models(self):
        backend = Backend(margin=0.01)
        decision = await decide(backend)
        assert (decision.calls, decision.reason) == (None, "gate_rejected")
        assert backend.requests["decision"] == []
        assert backend.requests["executor"] == []

    async def test_tool_vectors_are_embedded_once(self):
        backend = Backend()
        async with backend.client() as client:
            await try_fast_path([user("switch to night mode")], TOOLS, client=client)
            await try_fast_path([user("close the sidebar")], TOOLS, client=client)
        embedded = [t for body in backend.requests["embed"] for t in body["input"]]
        documents = [t for t in embedded if t.startswith(fast_path.DOC_PREFIX)]
        assert len(documents) == len(set(documents))

    async def test_tool_descriptions_get_a_longer_timeout_than_the_request(self, monkeypatch):
        """They are embedded once, about forty at a time, possibly while the
        embedding model is still loading. Under the per-request timeout that
        first batch failed, and so did every later run that retried it."""
        monkeypatch.setattr(settings, "fast_path_gate_timeout", 2.0)
        timeouts: dict[str, float] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            is_query = body["input"][0].startswith(fast_path.QUERY_PREFIX)
            timeouts["query" if is_query else "documents"] = request.extensions["timeout"]["read"]
            return httpx.Response(
                200, json={"data": [{"embedding": [1.0, 0.0]} for _ in body["input"]]}
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await fast_path.embed_margin(
                "night mode", [], fast_path.with_descriptions(TOOLS), client
            )

        assert timeouts["query"] == 2.0
        assert timeouts["documents"] == fast_path.DOCUMENTS_TIMEOUT > 2.0

    async def test_the_gate_reads_the_rewritten_description_of_a_direct_tool(self):
        backend = Backend()
        await decide(backend)
        embedded = [t for body in backend.requests["embed"] for t in body["input"]]
        assert any("Display command: switch the map" in t for t in embedded)
        assert not any("Set the map theme." in t for t in embedded)

    async def test_earlier_requests_are_part_of_the_query(self):
        backend = Backend()
        await decide(backend, [user("show history"), user("and the labels")])
        embedded = [t for body in backend.requests["embed"] for t in body["input"]]
        assert fast_path.QUERY_PREFIX + "show history and the labels" in embedded


class TestVeto:
    async def test_the_decision_model_can_stop_a_request_the_gate_passed(self):
        backend = Backend(command=0.3)
        decision = await decide(backend)
        assert (decision.calls, decision.reason) == (None, "vetoed")
        assert backend.requests["executor"] == []

    async def test_veto_disabled_skips_the_decision_model(self, monkeypatch):
        monkeypatch.setattr(settings, "fast_path_veto_enabled", False)
        backend = Backend(command=0.0)
        decision = await decide(backend)
        assert decision.reason == "handled"
        assert backend.requests["decision"] == []

    async def test_the_threshold_is_a_setting(self, monkeypatch):
        monkeypatch.setattr(settings, "fast_path_veto_below", 0.95)
        assert (await decide(Backend(command=0.9))).reason == "vetoed"

    async def test_the_request_is_sent_as_plain_text(self):
        """A nested object as state gave noisier answers from the decision model."""
        backend = Backend()
        await decide(backend)
        assert backend.requests["decision"][0]["state"] == "switch to night mode"


class TestExecutor:
    async def test_it_is_offered_the_direct_tools_and_the_hand_off_only(self):
        backend = Backend()
        await decide(backend)
        names = [t["function"]["name"] for t in backend.requests["executor"][0]["tools"]]
        assert names == ["setMapTheme", "toggleSidebar", HANDOFF]

    async def test_it_sees_the_rewritten_descriptions(self):
        backend = Backend()
        await decide(backend)
        theme = backend.requests["executor"][0]["tools"][0]["function"]
        assert theme["description"].startswith("Display command:")

    async def test_earlier_requests_alternate_with_assistant_turns(self):
        """Mistral's chat template rejects two user messages in a row."""
        backend = Backend()
        await decide(backend, [user("show history"), user("night mode")])
        roles = [m["role"] for m in backend.requests["executor"][0]["messages"]]
        assert roles == ["system", "user", "assistant", "user"]

    async def test_a_hand_off_goes_to_the_agent(self):
        decision = await decide(Backend(calls=[(HANDOFF, {"reason": "a question"})]))
        assert (decision.calls, decision.reason) == (None, "declined")

    async def test_a_text_reply_goes_to_the_agent(self):
        backend = Backend(calls=[])
        backend.text = "I will switch the theme."
        assert (await decide(backend)).reason == "declined"

    @pytest.mark.parametrize(
        "calls",
        [
            [("getAircraftSummary", {"hex": "4CA7B2"})],  # not a direct tool
            [("setMapTheme", {"theme": "purple"})],  # outside the enum
            [("setMapTheme", {})],  # required argument missing
            [("setMapTheme", {"theme": "dark", "zoom": 3})],  # unknown argument
            [("setMapTheme", {"theme": "dark"}), (HANDOFF, {})],  # acts and declines
        ],
    )
    async def test_a_call_that_cannot_be_trusted_goes_to_the_agent(self, calls):
        decision = await decide(Backend(calls=calls))
        assert decision.calls is None
        assert decision.reason in {"invalid", "declined"}


class TestFailOpen:
    @pytest.mark.parametrize("stage", ["embed", "decision", "executor"])
    async def test_a_failing_endpoint_sends_the_request_to_the_agent(self, stage):
        backend = Backend()
        backend.fail.add(stage)
        decision = await decide(backend)
        assert (decision.calls, decision.reason) == (None, "error")

    async def test_disabled(self, monkeypatch):
        monkeypatch.setattr(settings, "fast_path_enabled", False)
        backend = Backend()
        decision = await decide(backend)
        assert (decision.calls, decision.reason) == (None, "disabled")
        assert backend.requests["embed"] == []

    async def test_no_user_request(self):
        decision = await decide(Backend(), [SimpleNamespace(role="assistant", content="hi")])
        assert decision.reason == "no-question"

    async def test_a_run_that_continues_a_tool_call_is_not_a_new_request(self):
        """Only a fresh user message is a candidate; a tool result belongs to
        whoever made the call."""
        messages = [user("pan to Brest"), SimpleNamespace(role="tool", content="ok")]
        assert (await decide(Backend(), messages)).reason == "not-a-new-request"

    async def test_no_direct_tool_in_the_request(self):
        assert (await decide(Backend(), tools=[SUMMARY])).reason == "no-direct-tools"


def tool_result(call_id: str, content: str = '{"mapTheme":"dark"}') -> SimpleNamespace:
    return SimpleNamespace(role="tool", content=content, tool_call_id=call_id)


class TestClosing:
    def test_a_result_of_a_fast_path_call_closes_without_a_model(self):
        assert is_fast_path_closing([user("night mode"), tool_result("fp-1")])

    def test_a_result_of_an_agent_call_goes_to_the_agent(self):
        assert not is_fast_path_closing([user("night mode"), tool_result("call-1")])

    def test_a_new_user_message_is_not_a_closing_run(self):
        assert not is_fast_path_closing([tool_result("fp-1"), user("and now?")])

    def test_every_pending_result_must_be_a_fast_path_one(self):
        messages = [user("x"), tool_result("call-9"), tool_result("fp-1")]
        assert not is_fast_path_closing(messages)

    @pytest.mark.parametrize("content", ['{"error":"no such layer"}', "Error: tool failed"])
    def test_a_failed_action_is_left_to_the_agent_to_explain(self, content):
        assert not is_fast_path_closing([user("x"), tool_result("fp-1", content)])

    def test_disabled(self, monkeypatch):
        monkeypatch.setattr(settings, "fast_path_enabled", False)
        assert not is_fast_path_closing([user("x"), tool_result("fp-1")])


class TestArgsValid:
    def test_a_boolean_is_not_a_number(self):
        schema = {"properties": {"depthHours": {"type": "number"}}}
        assert not args_valid({"depthHours": True}, schema)
        assert args_valid({"depthHours": 6}, schema)


class TestPackagedDescriptions:
    def test_they_cover_only_direct_tools(self):
        assert set(fast_path.descriptions()) <= DIRECT_TOOLS

    def test_they_are_the_ones_that_were_evaluated(self):
        fixture = (
            Path(__file__).resolve().parents[2]
            / "eval"
            / "fastpath_agent"
            / "fixtures"
            / "tool_overrides_v2.json"
        )
        packaged = Path(fast_path.__file__).with_name("fast_path_descriptions.json")
        assert json.loads(packaged.read_text()) == json.loads(fixture.read_text())

    def test_parameter_descriptions_are_overlaid_without_touching_the_original(self):
        tool = _tool("setMapTheme", "old", {"theme": {"type": "string", "description": "old"}})
        overlaid = fast_path.with_descriptions([tool])[0]
        assert overlaid.description.startswith("Display command:")
        assert tool.description == "old"


def test_defaults_are_on():
    from adsb_agent.config import Settings

    assert Settings.model_fields["fast_path_enabled"].default is True
    assert Settings.model_fields["fast_path_veto_enabled"].default is True
    assert Settings.model_fields["fast_path_question_check_enabled"].default is True

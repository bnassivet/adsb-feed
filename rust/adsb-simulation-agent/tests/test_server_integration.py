"""End-to-end over the real A2A HTTP surface.

Exercises what `adsb-agent` will actually do: fetch the agent card for
discovery, then send a message and read the trajectory back off the task's
artifacts. Uses an in-process ASGI transport, so no port is bound.
"""

from __future__ import annotations

from contextlib import contextmanager

import httpx
import pytest
from starlette.applications import Starlette

from adsb_simulation_agent.agent_card import AGENT_NAME, SKILL_GENERATE_TRAJECTORY
from adsb_simulation_agent.config import settings
from adsb_simulation_agent.server import build_app, build_llm, reasoning_kwargs

BASE = "http://testserver"
CARD_PATH = "/.well-known/agent-card.json"

A2A_VERSION_HEADERS = {"A2A-Version": "1.0"}
"""Protocol version is negotiated by header. Omitting it means '0.3', which a
1.0 handler rejects outright — the single most likely integration failure for
any client written against pre-1.0 examples."""


@pytest.fixture
def app() -> Starlette:
    # llm=None: no LM Studio needed for the protocol layer.
    return build_app(base_url=BASE, llm=None)


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    # Without the A2A-Version header the server assumes protocol 0.3 and
    # rejects the call with VERSION_NOT_SUPPORTED. Any client of this service
    # must send it — see A2A_VERSION_HEADERS.
    async with httpx.AsyncClient(
        transport=transport, base_url=BASE, headers=A2A_VERSION_HEADERS
    ) as c:
        yield c


class TestAppConstruction:
    def test_builds_a_starlette_app(self, app):
        assert isinstance(app, Starlette)

    def test_registers_the_agent_card_and_rpc_routes(self, app):
        paths = {getattr(r, "path", None) for r in app.routes}
        assert CARD_PATH in paths


class TestAgentCardDiscovery:
    async def test_card_is_served_at_the_well_known_path(self, client):
        """v1.x renamed this from agent.json to agent-card.json."""
        response = await client.get(CARD_PATH)
        assert response.status_code == 200
        assert response.json()["name"] == AGENT_NAME

    async def test_card_advertises_the_trajectory_skill(self, client):
        card = (await client.get(CARD_PATH)).json()
        assert any(s["id"] == SKILL_GENERATE_TRAJECTORY for s in card["skills"])

    async def test_card_declares_its_endpoint(self, client):
        card = (await client.get(CARD_PATH)).json()
        interfaces = card["supportedInterfaces"]
        assert any(i["url"].startswith(BASE) for i in interfaces)


class TestHealth:
    async def test_health_endpoint_reports_healthy(self, client):
        response = await client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "healthy"


SEND_MESSAGE = "SendMessage"
"""a2a-sdk v1.0 uses gRPC-style PascalCase JSON-RPC method names. The old
dotted/slashed names (`message/send`) only work with `enable_v0_3_compat`."""


def _send_message_payload(data: dict, request_id: str = "1") -> dict:
    """A JSON-RPC SendMessage envelope carrying a structured data part."""
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": SEND_MESSAGE,
        "params": {
            "message": {
                "messageId": "msg-1",
                "role": "ROLE_USER",
                "parts": [{"data": data}],
            }
        },
    }


async def _send(client, data: dict) -> dict:
    """Send a SendMessage RPC and return the Task from `result.task`."""
    response = await client.post("/", json=_send_message_payload(data))
    assert response.status_code == 200, response.text
    body = response.json()
    assert "error" not in body, body
    return body["result"]["task"]


class TestTrajectoryRoundTrip:
    async def test_generates_a_trajectory_over_jsonrpc(self, client):
        task = await _send(
            client,
            {"origin_lat": 45.5, "origin_lng": -73.6, "category": "helicopter", "count": 2},
        )
        assert task["status"]["state"] == "TASK_STATE_COMPLETED"

    async def test_artifact_carries_the_waypoints(self, client):
        task = await _send(client, {"origin_lat": 45.5, "origin_lng": -73.6, "category": "ga"})
        artifacts = task.get("artifacts") or []
        assert artifacts, f"no artifacts in {task}"

        data = artifacts[0]["parts"][0]["data"]
        assert data["aircraft"]
        waypoint = data["aircraft"][0]["waypoints"][0]
        for field in ("lat", "lng", "alt_ft", "speed_kts", "heading_deg", "phase", "t_offset_s"):
            assert field in waypoint

    async def test_artifact_includes_the_compact_summary(self, client):
        """What adsb-agent will put in its LLM's ToolMessage."""
        task = await _send(client, {"origin_lat": 45.5, "origin_lng": -73.6, "count": 2})
        data = task["artifacts"][0]["parts"][0]["data"]
        assert "2 aircraft" in data["summary"]

    async def test_terminal_status_message_is_the_summary(self, client):
        task = await _send(client, {"origin_lat": 45.5, "origin_lng": -73.6})
        text = task["status"]["message"]["parts"][0]["text"]
        assert "aircraft" in text

    async def test_count_is_honoured_over_the_wire(self, client):
        task = await _send(client, {"origin_lat": 45.5, "origin_lng": -73.6, "count": 3})
        assert len(task["artifacts"][0]["parts"][0]["data"]["aircraft"]) == 3

    async def test_route_hint_is_accepted_over_the_wire(self, client):
        task = await _send(
            client,
            {"origin_lat": 45.5, "origin_lng": -73.6, "routeHint": "circle downtown"},
        )
        assert task["status"]["state"] == "TASK_STATE_COMPLETED"


class TestFailureReporting:
    async def test_invalid_origin_reports_a_failed_task(self, client):
        response = await client.post("/", json=_send_message_payload({"category": "ga"}))
        assert response.status_code == 200, response.text
        task = response.json()["result"]["task"]
        assert task["status"]["state"] == "TASK_STATE_FAILED"

    async def test_failure_message_explains_the_problem(self, client):
        response = await client.post("/", json=_send_message_payload({"category": "ga"}))
        task = response.json()["result"]["task"]
        assert "origin" in task["status"]["message"]["parts"][0]["text"].lower()


TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
"""A well-formed W3C traceparent, as adsb-agent would send."""


class TestDistributedTracing:
    """The link to the caller's MLflow trace, exercised over real HTTP.

    Patches the mlflow entry point rather than our wrapper, so these tests fail
    if the request path stops reaching mlflow at all.

    Note the split: middleware only *captures* the headers, and the executor
    joins the trace — see `test_trace_is_joined_around_the_span`.
    """

    @pytest.fixture
    def joined(self, monkeypatch):
        """Record every attempt to join a caller's trace."""
        import mlflow.tracing

        calls: list[dict] = []

        @contextmanager
        def _spy(headers):
            calls.append(headers)
            yield

        monkeypatch.setattr(mlflow.tracing, "set_tracing_context_from_http_request_headers", _spy)
        return calls

    async def test_traceparent_is_handed_to_mlflow(self, client, joined):
        await client.post(
            "/",
            json=_send_message_payload({"origin_lat": 45.5, "origin_lng": -73.6}),
            headers={"traceparent": TRACEPARENT},
        )
        assert len(joined) == 1
        assert joined[0]["traceparent"] == TRACEPARENT

    async def test_request_without_traceparent_starts_its_own_trace(self, client, joined):
        await client.post(
            "/", json=_send_message_payload({"origin_lat": 45.5, "origin_lng": -73.6})
        )
        assert joined == []

    async def test_linked_request_still_returns_a_trajectory(self, client, joined):
        """Tracing must be transparent to the protocol surface."""
        response = await client.post(
            "/",
            json=_send_message_payload({"origin_lat": 45.5, "origin_lng": -73.6, "count": 2}),
            headers={"traceparent": TRACEPARENT},
        )
        task = response.json()["result"]["task"]
        assert task["status"]["state"] == "TASK_STATE_COMPLETED"
        assert len(task["artifacts"][0]["parts"][0]["data"]["aircraft"]) == 2

    async def test_malformed_traceparent_does_not_break_the_request(self, client, monkeypatch):
        """A bad header degrades to an unlinked trace, never to a failed task."""
        import mlflow.tracing

        def _boom(headers):
            raise ValueError("malformed traceparent")

        monkeypatch.setattr(mlflow.tracing, "set_tracing_context_from_http_request_headers", _boom)
        response = await client.post(
            "/",
            json=_send_message_payload({"origin_lat": 45.5, "origin_lng": -73.6}),
            headers={"traceparent": "garbage"},
        )
        assert response.json()["result"]["task"]["status"]["state"] == "TASK_STATE_COMPLETED"

    async def test_trace_is_joined_around_the_span_not_the_request(self, client, monkeypatch):
        """Regression: the executor's span was being dropped on export.

        a2a-sdk runs the executor in a detached task that is NOT awaited before
        the HTTP response is sent. When the trace scope was opened in middleware
        it closed with the response, leaving `simulate_trajectory` open outside
        any attached context — MLflow then dropped it and every child span was
        orphaned. So the scope must still be open when the span ends.
        """
        import mlflow.tracing

        events: list[str] = []

        @contextmanager
        def _spy_scope(_headers):
            events.append("scope-enter")
            try:
                yield
            finally:
                events.append("scope-exit")

        monkeypatch.setattr(
            mlflow.tracing, "set_tracing_context_from_http_request_headers", _spy_scope
        )

        class _Span:
            def __getattr__(self, _name):
                return lambda *a, **kw: None

            def __enter__(self):
                events.append("span-start")
                return self

            def __exit__(self, *_exc):
                events.append("span-end")
                return False

        import mlflow

        monkeypatch.setattr(mlflow, "start_span", lambda name, span_type: _Span())

        await client.post(
            "/",
            json=_send_message_payload({"origin_lat": 45.5, "origin_lng": -73.6}),
            headers={"traceparent": TRACEPARENT},
        )

        assert events[0] == "scope-enter"
        assert events.index("span-end") < events.index("scope-exit")

    async def test_health_endpoint_is_unaffected(self, client, joined):
        """Middleware wraps every route; a non-A2A route must still work."""
        response = await client.get("/health", headers={"traceparent": TRACEPARENT})
        assert response.status_code == 200


class TestProtocolVersioning:
    async def test_missing_version_header_is_rejected(self, app):
        """Documents the failure mode a pre-1.0 client would hit."""
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url=BASE) as bare:
            response = await bare.post(
                "/", json=_send_message_payload({"origin_lat": 45.5, "origin_lng": -73.6})
            )
        assert "error" in response.json()


class TestLLMRetryBudgetIsBounded:
    """The OpenAI client must not silently multiply the timeout.

    `ChatOpenAI` defaults to `max_retries=2`, so one classification is really
    three attempts. With `llm_timeout_s=300` that is a 900-second worst case for
    a call the caller abandons after 60 — the retries buy nothing and are
    invisible in the logs. `intent.parse_route_hint` already owns the one retry
    that is worth making (a truncated answer, with a bigger budget).
    """

    def test_the_chat_model_does_not_retry_internally(self):
        llm = build_llm()
        if llm is None:  # langchain_openai absent — nothing to assert
            pytest.skip("langchain_openai not installed")
        assert llm.max_retries == 0

    def test_the_configured_timeout_is_applied(self):
        llm = build_llm()
        if llm is None:
            pytest.skip("langchain_openai not installed")
        assert llm.request_timeout == settings.llm_timeout_s


class TestReasoningBudget:
    """Reasoning controls are pass-through, and absent unless configured.

    Reasoning tokens come out of the same `max_tokens` budget as the answer, so
    a model that thinks hard returns `finish_reason='length'` with empty
    content. These knobs ask it to think less. Support varies by provider, so
    they are only *sent* when set — an unconditional `reasoning_effort: None`
    would be a new field on every request for no benefit.
    """

    def test_nothing_is_sent_when_unconfigured(self):
        assert reasoning_kwargs(effort=None, max_tokens=None) == {}

    def test_effort_is_passed_through(self):
        assert reasoning_kwargs(effort="low", max_tokens=None) == {"reasoning_effort": "low"}

    def test_effort_is_normalised(self):
        assert reasoning_kwargs(effort="  LOW  ", max_tokens=None) == {"reasoning_effort": "low"}

    def test_a_blank_effort_is_treated_as_unset(self):
        assert reasoning_kwargs(effort="   ", max_tokens=None) == {}

    def test_max_tokens_becomes_a_reasoning_budget(self):
        assert reasoning_kwargs(effort=None, max_tokens=256) == {
            "extra_body": {"reasoning": {"max_tokens": 256}}
        }

    def test_both_can_be_sent_together(self):
        assert reasoning_kwargs(effort="minimal", max_tokens=128) == {
            "reasoning_effort": "minimal",
            "extra_body": {"reasoning": {"max_tokens": 128}},
        }

    def test_a_non_positive_budget_is_ignored(self):
        """Zero would be a request to disable reasoning, which is not what the
        field means and which no provider spells this way."""
        assert reasoning_kwargs(effort=None, max_tokens=0) == {}
        assert reasoning_kwargs(effort=None, max_tokens=-5) == {}

    def test_the_model_carries_the_configured_controls(self, monkeypatch):
        monkeypatch.setattr(settings, "reasoning_effort", "low", raising=False)
        monkeypatch.setattr(settings, "reasoning_max_tokens", 200, raising=False)
        llm = build_llm()
        if llm is None:
            pytest.skip("langchain_openai not installed")
        assert llm.reasoning_effort == "low"
        assert llm.extra_body == {"reasoning": {"max_tokens": 200}}

    def test_the_model_carries_none_when_unconfigured(self, monkeypatch):
        monkeypatch.setattr(settings, "reasoning_effort", None, raising=False)
        monkeypatch.setattr(settings, "reasoning_max_tokens", None, raising=False)
        llm = build_llm()
        if llm is None:
            pytest.skip("langchain_openai not installed")
        assert llm.reasoning_effort is None
        assert not llm.extra_body


class TestReasoningOnOff:
    """Some models expose reasoning as a toggle, not a dial.

    `gemma-4-12b-qat` is one: `reasoning_effort="none"` turns it off (measured
    4s / 162 tokens versus 23s / 1083 with it on), while `minimal`/`low` and the
    `reasoning={enabled:false}` and `chat_template_kwargs` spellings are all
    accepted and silently ignored. So the off switch has to be expressible
    plainly, and the obvious words for it must reach the one value that works.
    """

    @pytest.mark.parametrize("word", ["off", "OFF", " off ", "false", "no", "disabled", "none"])
    def test_off_synonyms_all_reach_none(self, word):
        assert reasoning_kwargs(effort=word, max_tokens=None) == {"reasoning_effort": "none"}

    @pytest.mark.parametrize("word", ["on", "true", "yes", "enabled"])
    def test_on_synonyms_send_nothing(self, word):
        """On is the model's own default; saying so explicitly would only risk
        an endpoint rejecting a value it doesn't know."""
        assert reasoning_kwargs(effort=word, max_tokens=None) == {}

    @pytest.mark.parametrize("level", ["minimal", "low", "medium", "high"])
    def test_graded_levels_still_pass_through(self, level):
        """For providers that do implement a dial."""
        assert reasoning_kwargs(effort=level, max_tokens=None) == {"reasoning_effort": level}

    def test_off_survives_alongside_a_token_cap(self):
        assert reasoning_kwargs(effort="off", max_tokens=128) == {
            "reasoning_effort": "none",
            "extra_body": {"reasoning": {"max_tokens": 128}},
        }

    def test_an_unknown_word_is_passed_through_untouched(self):
        """Not our place to second-guess a provider we don't know."""
        assert reasoning_kwargs(effort="ultra", max_tokens=None) == {"reasoning_effort": "ultra"}

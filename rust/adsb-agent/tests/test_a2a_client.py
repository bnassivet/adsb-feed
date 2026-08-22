"""A2A client for the simulation agent.

The simulation agent speaks a2a-sdk v1.x, which differs sharply from pre-1.0
examples. Two details are load-bearing and each has a test here:

* The `A2A-Version: 1.0` header is mandatory — without it the server assumes
  protocol 0.3 and rejects the call outright.
* Failures arrive as `TASK_STATE_FAILED` *inside a successful JSON-RPC
  response*, not as a JSON-RPC error, so task state must be inspected.
"""

from __future__ import annotations

import json

import httpx
import pytest

from adsb_agent.a2a_client import (
    A2A_VERSION,
    A2A_VERSION_HEADER,
    SEND_MESSAGE_METHOD,
    build_send_message_request,
    build_trajectory_payload,
    call_simulation_agent,
    parse_task_response,
)
from adsb_agent.config import settings


def _task_response(state: str, artifacts=None, message_text="ok") -> dict:
    task: dict = {
        "id": "t1",
        "contextId": "c1",
        "status": {
            "state": state,
            "message": {"parts": [{"text": message_text}]},
        },
    }
    if artifacts is not None:
        task["artifacts"] = artifacts
    return {"jsonrpc": "2.0", "id": "1", "result": {"task": task}}


def _artifact(data: dict) -> dict:
    return {"artifactId": "a1", "name": "trajectory", "parts": [{"data": data}]}


TRAJECTORY_DATA = {
    "aircraft": [{"hex_ident": "SIM-1", "callsign": "HELI001", "waypoints": [{"lat": 1}]}],
    "violations": [],
    "summary": "1 aircraft (helicopter), 86 waypoints, 11 min",
}


class TestPayloadBuilding:
    def test_maps_camel_case_tool_args(self):
        payload = build_trajectory_payload(
            {
                "category": "helicopter",
                "count": 2,
                "routeHint": "circle downtown",
                "originLat": 45.5,
                "originLng": -73.6,
                "cruiseAltitudeFt": 1500,
            }
        )
        assert payload["category"] == "helicopter"
        assert payload["count"] == 2
        assert payload["routeHint"] == "circle downtown"
        assert payload["originLat"] == 45.5
        assert payload["cruiseAltitudeFt"] == 1500

    def test_drops_absent_optional_fields(self):
        payload = build_trajectory_payload({"category": "ga"})
        assert "routeHint" not in payload
        assert "cruiseAltitudeFt" not in payload

    def test_passes_origin_through_untouched(self):
        """Origin comes from the receiver location and must not be reinterpreted."""
        payload = build_trajectory_payload({"originLat": -33.9, "originLng": 151.2})
        assert payload["originLat"] == -33.9
        assert payload["originLng"] == 151.2


class TestRequestEnvelope:
    def test_uses_the_v1_pascal_case_method(self):
        """v1.0 renamed `message/send` to `SendMessage`."""
        request = build_send_message_request({"category": "ga"})
        assert request["method"] == SEND_MESSAGE_METHOD == "SendMessage"
        assert request["jsonrpc"] == "2.0"

    def test_wraps_the_payload_in_a_data_part(self):
        request = build_send_message_request({"category": "ga"})
        parts = request["params"]["message"]["parts"]
        assert parts[0]["data"]["category"] == "ga"

    def test_message_declares_the_user_role(self):
        request = build_send_message_request({})
        assert request["params"]["message"]["role"] == "ROLE_USER"


class TestResponseParsing:
    def test_extracts_data_and_summary_from_a_completed_task(self):
        result = parse_task_response(
            _task_response("TASK_STATE_COMPLETED", [_artifact(TRAJECTORY_DATA)])
        )
        assert result.ok
        assert result.data["aircraft"]
        assert "86 waypoints" in result.summary

    def test_failed_task_is_an_error_despite_a_200_response(self):
        """The most likely mistake: treating any non-JSON-RPC-error as success."""
        response = _task_response(
            "TASK_STATE_FAILED", message_text="origin_lat and origin_lng are required"
        )
        result = parse_task_response(response)
        assert not result.ok
        assert "origin" in result.error

    def test_jsonrpc_error_is_surfaced(self):
        result = parse_task_response(
            {"jsonrpc": "2.0", "id": "1", "error": {"code": -32601, "message": "Method not found"}}
        )
        assert not result.ok
        assert "Method not found" in result.error

    def test_version_rejection_is_reported_clearly(self):
        result = parse_task_response(
            {
                "jsonrpc": "2.0",
                "id": "1",
                "error": {
                    "code": -32009,
                    "message": "A2A version '0.3' is not supported by this handler.",
                },
            }
        )
        assert not result.ok
        assert "0.3" in result.error

    def test_completed_task_without_artifacts_is_an_error(self):
        result = parse_task_response(_task_response("TASK_STATE_COMPLETED", []))
        assert not result.ok

    def test_malformed_body_is_an_error_not_an_exception(self):
        assert not parse_task_response({}).ok
        assert not parse_task_response({"result": {}}).ok

    def test_summary_falls_back_when_absent_from_the_artifact(self):
        data = {"aircraft": [{"waypoints": []}], "violations": []}
        result = parse_task_response(
            _task_response("TASK_STATE_COMPLETED", [_artifact(data)])
        )
        assert result.ok
        assert result.summary


class TestCallSimulationAgent:
    async def test_sends_the_mandatory_version_header(self):
        """Omitting A2A-Version means '0.3' and the server rejects the call."""
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["headers"] = request.headers
            seen["body"] = json.loads(request.content)
            return httpx.Response(
                200, json=_task_response("TASK_STATE_COMPLETED", [_artifact(TRAJECTORY_DATA)])
            )

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            result = await call_simulation_agent({"category": "helicopter"}, client)

        assert result.ok
        assert seen["headers"][A2A_VERSION_HEADER] == A2A_VERSION == "1.0"

    async def test_sends_the_payload_as_a_data_part(self):
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["body"] = json.loads(request.content)
            return httpx.Response(
                200, json=_task_response("TASK_STATE_COMPLETED", [_artifact(TRAJECTORY_DATA)])
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await call_simulation_agent(
                {"category": "fighter", "originLat": 45.5, "originLng": -73.6}, client
            )

        data = seen["body"]["params"]["message"]["parts"][0]["data"]
        assert data["category"] == "fighter"
        assert data["originLat"] == 45.5

    async def test_connection_refused_returns_a_readable_error(self):
        """A stopped simulation agent must not break the chat turn."""

        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await call_simulation_agent({"category": "ga"}, client)

        assert not result.ok
        assert "simulation agent" in result.error.lower()

    async def test_http_error_status_is_handled(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="boom")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await call_simulation_agent({"category": "ga"}, client)

        assert not result.ok

    async def test_non_json_response_is_handled(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="<html>not json</html>")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await call_simulation_agent({"category": "ga"}, client)

        assert not result.ok

    async def test_failed_task_surfaces_its_reason(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json=_task_response("TASK_STATE_FAILED", message_text="origin is required"),
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await call_simulation_agent({}, client)

        assert not result.ok
        assert "origin" in result.error


@pytest.mark.parametrize(
    "state", ["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_CANCELED"]
)
def test_non_terminal_states_are_not_treated_as_success(state):
    assert not parse_task_response(_task_response(state, [_artifact(TRAJECTORY_DATA)])).ok


class TestTimeoutIsReportedAsTimeout:
    """A timeout must not be reported as "is it running?".

    Found the hard way: a slow classification hop made the UI say the agent
    could not be reached, with an empty parenthetical — `httpx.ReadTimeout`
    stringifies to "" — so the message read "...at http://127.0.0.1:8300 ().
    Is it running?" while the agent was up and answering. That sends you to
    check the wrong thing entirely.
    """

    @pytest.mark.asyncio
    async def test_a_read_timeout_says_it_timed_out(self, monkeypatch):
        async def raise_timeout(*_a, **_kw):
            raise httpx.ReadTimeout("")

        monkeypatch.setattr(httpx.AsyncClient, "post", raise_timeout)
        async with httpx.AsyncClient() as client:
            result = await call_simulation_agent({"originLat": 45.0, "originLng": -73.0}, client)

        assert result.ok is False
        assert "timed out" in result.error.lower()
        assert "is it running" not in result.error.lower()

    @pytest.mark.asyncio
    async def test_the_timeout_message_names_the_budget(self, monkeypatch):
        """So the reader can tell "raise the timeout" from "the agent is down"."""

        async def raise_timeout(*_a, **_kw):
            raise httpx.ConnectTimeout("")

        monkeypatch.setattr(httpx.AsyncClient, "post", raise_timeout)
        async with httpx.AsyncClient() as client:
            result = await call_simulation_agent({"originLat": 45.0, "originLng": -73.0}, client)

        assert str(int(settings.simulation_agent_timeout)) in result.error

    @pytest.mark.asyncio
    async def test_a_real_connection_error_still_asks_if_it_is_running(self, monkeypatch):
        async def raise_connect(*_a, **_kw):
            raise httpx.ConnectError("[Errno 61] Connection refused")

        monkeypatch.setattr(httpx.AsyncClient, "post", raise_connect)
        async with httpx.AsyncClient() as client:
            result = await call_simulation_agent({"originLat": 45.0, "originLng": -73.0}, client)

        assert result.ok is False
        assert "is it running" in result.error.lower()

    @pytest.mark.asyncio
    async def test_an_empty_exception_message_still_names_the_failure(self, monkeypatch):
        """`str(e)` is empty for several httpx errors; the type must survive."""

        async def raise_blank(*_a, **_kw):
            raise httpx.ConnectError("")

        monkeypatch.setattr(httpx.AsyncClient, "post", raise_blank)
        async with httpx.AsyncClient() as client:
            result = await call_simulation_agent({"originLat": 45.0, "originLng": -73.0}, client)

        assert "ConnectError" in result.error
        assert "()" not in result.error

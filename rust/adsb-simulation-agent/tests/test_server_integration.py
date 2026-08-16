"""End-to-end over the real A2A HTTP surface.

Exercises what `adsb-agent` will actually do: fetch the agent card for
discovery, then send a message and read the trajectory back off the task's
artifacts. Uses an in-process ASGI transport, so no port is bound.
"""

from __future__ import annotations

import httpx
import pytest
from starlette.applications import Starlette

from adsb_simulation_agent.agent_card import AGENT_NAME, SKILL_GENERATE_TRAJECTORY
from adsb_simulation_agent.server import build_app

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


class TestProtocolVersioning:
    async def test_missing_version_header_is_rejected(self, app):
        """Documents the failure mode a pre-1.0 client would hit."""
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url=BASE) as bare:
            response = await bare.post(
                "/", json=_send_message_payload({"origin_lat": 45.5, "origin_lng": -73.6})
            )
        assert "error" in response.json()

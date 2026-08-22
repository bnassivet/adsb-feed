"""`POST /simulate/trajectory` — the simulation panel's non-chat entry point.

The panel submits a form; faking a chat turn for that would be absurd. This
endpoint shares `a2a_client.call_simulation_agent` with the chat tool, so both
paths hit the simulation agent identically.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from adsb_agent import main as m
from adsb_agent.a2a_client import TrajectoryResult

TRAJECTORY_DATA = {
    "aircraft": [
        {
            "hex_ident": "SIM-A1",
            "callsign": "HELI001",
            "category": "helicopter",
            "waypoints": [{"lat": 45.5, "lng": -73.6, "alt_ft": 1200}],
        }
    ],
    "violations": [],
    "summary": "1 aircraft (helicopter), 86 waypoints, 11 min",
}


@pytest.fixture
async def client():
    async with AsyncClient(
        transport=ASGITransport(app=m.app), base_url="http://test"
    ) as c:
        yield c


@pytest.fixture
def ok_agent(monkeypatch):
    async def fake_call(args, http_client):
        fake_call.args = args
        return TrajectoryResult(
            ok=True, summary=TRAJECTORY_DATA["summary"], data=TRAJECTORY_DATA
        )

    monkeypatch.setattr(m, "call_simulation_agent", fake_call)
    return fake_call


class TestSuccess:
    async def test_returns_the_trajectory(self, client, ok_agent):
        response = await client.post(
            "/simulate/trajectory",
            json={"category": "helicopter", "originLat": 45.5, "originLng": -73.6},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["aircraft"][0]["callsign"] == "HELI001"

    async def test_includes_the_summary(self, client, ok_agent):
        response = await client.post(
            "/simulate/trajectory",
            json={"category": "ga", "originLat": 45.5, "originLng": -73.6},
        )
        assert "86 waypoints" in response.json()["summary"]

    async def test_forwards_the_form_fields(self, client, ok_agent):
        await client.post(
            "/simulate/trajectory",
            json={
                "category": "fighter",
                "count": 3,
                "routeHint": "aerobatics overhead",
                "originLat": 45.5,
                "originLng": -73.6,
                "cruiseAltitudeFt": 9000,
            },
        )
        assert ok_agent.args["category"] == "fighter"
        assert ok_agent.args["count"] == 3
        assert ok_agent.args["routeHint"] == "aerobatics overhead"
        assert ok_agent.args["cruiseAltitudeFt"] == 9000

    async def test_origin_is_passed_through(self, client, ok_agent):
        """The panel supplies the receiver location; it must not be reinterpreted."""
        await client.post(
            "/simulate/trajectory",
            json={"category": "ga", "originLat": -33.9, "originLng": 151.2},
        )
        assert ok_agent.args["originLat"] == -33.9
        assert ok_agent.args["originLng"] == 151.2


class TestFailure:
    async def test_unreachable_agent_returns_a_readable_error(self, client, monkeypatch):
        async def fake_call(args, http_client):
            return TrajectoryResult(
                ok=False, error="could not reach the simulation agent at http://127.0.0.1:8300"
            )

        monkeypatch.setattr(m, "call_simulation_agent", fake_call)
        response = await client.post(
            "/simulate/trajectory",
            json={"category": "ga", "originLat": 45.5, "originLng": -73.6},
        )
        assert response.status_code == 502
        assert "simulation agent" in response.json()["detail"]

    async def test_missing_origin_is_rejected_by_validation(self, client):
        response = await client.post("/simulate/trajectory", json={"category": "ga"})
        assert response.status_code == 422

    async def test_bad_category_is_rejected_by_validation(self, client):
        response = await client.post(
            "/simulate/trajectory",
            json={"category": "spaceship", "originLat": 45.5, "originLng": -73.6},
        )
        assert response.status_code == 422

    async def test_out_of_range_latitude_is_rejected(self, client):
        response = await client.post(
            "/simulate/trajectory",
            json={"category": "ga", "originLat": 999, "originLng": 0},
        )
        assert response.status_code == 422


class TestSchema:
    async def test_endpoint_appears_in_openapi(self, client):
        schema = (await client.get("/openapi.json")).json()
        assert "/simulate/trajectory" in schema["paths"]

    async def test_endpoint_is_tagged(self, client):
        schema = (await client.get("/openapi.json")).json()
        operation = schema["paths"]["/simulate/trajectory"]["post"]
        assert operation.get("tags")

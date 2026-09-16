"""The /metrics endpoint on the A2A app."""

import httpx
import pytest

from adsb_simulation_agent.server import build_app


async def get(path: str) -> httpx.Response:
    """GET a path on a freshly built app, without binding a port."""
    app = build_app(base_url="http://test")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path)


@pytest.mark.asyncio
async def test_metrics_endpoint_returns_prometheus_text():
    response = await get("/metrics")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert "adsb_build_info" in response.text


@pytest.mark.asyncio
async def test_the_identity_series_names_this_service():
    assert 'service="adsb-simulation-agent"' in (await get("/metrics")).text


@pytest.mark.asyncio
async def test_metrics_is_registered_beside_health():
    # Both are plain routes on the same app as the A2A JSON-RPC surface, so a
    # scraper and the agent card live at one origin.
    assert (await get("/health")).status_code == 200
    assert (await get("/metrics")).status_code == 200

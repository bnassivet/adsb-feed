"""The agent advertises its backend tools as AG-UI capabilities.

AG-UI ``AgentCapabilities.tools`` (``@ag-ui/core`` 1.0.x ``ToolsCapabilities``):
``items`` holds "the tools this agent provides on its own (full JSON Schema
definitions)", and ``clientProvided`` says the agent also accepts tools from
``RunAgentInput.tools``. CopilotKit 1.85 reads ``agents[id].capabilities`` from
the runtime ``/info`` response into ``agent.getCapabilities()``. Older
versions ignore the field.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from adsb_agent.server_tools import SERVER_TOOLS


@pytest.fixture
def client():
    from adsb_agent.main import app

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _info(client: AsyncClient, how: str) -> dict:
    if how == "single":
        resp = await client.post("/ag-ui", json={"method": "info"})
    else:
        resp = await client.get(how)
    assert resp.status_code == 200
    return resp.json()


@pytest.mark.parametrize("how", ["/ag-ui/info", "/info", "single"])
async def test_every_info_route_advertises_the_backend_tools(client, how):
    tools = (await _info(client, how))["agents"]["adsb_agent"]["capabilities"]["tools"]

    assert tools["supported"] is True
    assert tools["clientProvided"] is True
    assert tools["parallelCalls"] is False
    assert [t["name"] for t in tools["items"]] == [t.name for t in SERVER_TOOLS]


async def test_items_carry_full_json_schema(client):
    tools = (await _info(client, "/ag-ui/info"))["agents"]["adsb_agent"]["capabilities"]["tools"]
    traj = next(t for t in tools["items"] if t["name"] == "getTrajectory")

    assert traj["description"]
    assert traj["parameters"]["type"] == "object"
    assert traj["parameters"]["required"] == ["hexIdent"]


async def test_description_is_still_present(client):
    """CopilotKit 1.55 reads only `description`; it must survive."""
    agent = (await _info(client, "/ag-ui/info"))["agents"]["adsb_agent"]
    assert agent["description"]

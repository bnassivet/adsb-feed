"""AG-UI `connect`: rejoin a thread before running on it.

CopilotKit >= 1.85's `CopilotChat` calls `connect` for an explicit `threadId`
before the first run, and a 404 there aborts the chat ("Could not load saved
conversation"). The response is a replay of the thread's history as an SSE
event stream; the client prepends an empty MESSAGES_SNAPSHOT/STATE_SNAPSHOT
itself, so an empty stream means "no history".

This agent is stateless -- the client sends the full message list on every
run, and the desktop mints a fresh thread id each time the chat opens -- so
there is never anything to replay.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from adsb_agent.main import app

_INPUT = {
    "threadId": "t-1",
    "runId": "r-1",
    "state": {},
    "messages": [],
    "tools": [],
    "context": [],
    "forwardedProps": {},
}


@pytest.fixture
def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_rest_connect_returns_an_empty_event_stream(client):
    resp = await client.post("/ag-ui/agent/adsb_agent/connect", json=_INPUT)

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert resp.text.strip() == ""


async def test_single_endpoint_connect_is_an_event_stream_not_runtime_info(client):
    """It used to return the `/info` JSON, which is not an AG-UI event stream."""
    resp = await client.post(
        "/ag-ui",
        json={"method": "agent/connect", "params": {"agentId": "adsb_agent"}, "body": _INPUT},
    )

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert resp.text.strip() == ""

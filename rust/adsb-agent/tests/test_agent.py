"""Tests for the FastAPI AG-UI endpoint."""

import pytest
from httpx import ASGITransport, AsyncClient

from adsb_agent.main import app


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def test_health_endpoint(client: AsyncClient):
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "healthy"
    assert data["service"] == "adsb-agent"


async def test_chat_endpoint_returns_sse(client: AsyncClient, monkeypatch):
    """Chat endpoint should return SSE content type and stream events."""
    # Mock the LLM to avoid needing a real LM Studio instance
    import adsb_agent.main as main_mod
    from ag_ui.core import (
        EventType,
        TextMessageContentEvent,
        TextMessageEndEvent,
        TextMessageStartEvent,
    )

    async def mock_stream(*args, **kwargs):
        yield TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START,
            message_id="test-msg",
            role="assistant",
        )
        yield TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id="test-msg",
            delta="Hello!",
        )
        yield TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END,
            message_id="test-msg",
        )

    monkeypatch.setattr(main_mod, "stream_llm_response", mock_stream)

    resp = await client.post(
        "/ag-ui/chat",
        json={
            "threadId": "t1",
            "runId": "r1",
            "messages": [
                {"id": "m1", "role": "user", "content": "Hello"}
            ],
            "tools": [],
            "context": [],
            "state": {},
            "forwardedProps": {},
        },
    )

    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers["content-type"]

    # Parse SSE events
    body = resp.text
    events = [line for line in body.split("\n") if line.startswith("data:")]
    assert len(events) >= 3  # RUN_STARTED + message events + RUN_FINISHED

    # First event should be RUN_STARTED
    assert "RUN_STARTED" in events[0]
    # Last event should be RUN_FINISHED
    assert "RUN_FINISHED" in events[-1]


async def test_chat_rejects_invalid_body(client: AsyncClient):
    """Typed RunAgentInput body → 422 on missing required fields."""
    resp = await client.post("/ag-ui/chat", json={"not_valid": True})
    assert resp.status_code == 422
    assert "detail" in resp.json()


async def test_agui_single_endpoint_info(client: AsyncClient):
    """POST /ag-ui with method=info returns runtime info JSON."""
    resp = await client.post("/ag-ui", json={"method": "info", "params": {}, "body": {}})
    assert resp.status_code == 200
    data = resp.json()
    assert "agents" in data


async def test_agui_single_endpoint_connect(client: AsyncClient):
    """POST /ag-ui with method=agent/connect returns runtime info (CopilotKit lifecycle)."""
    resp = await client.post("/ag-ui", json={"method": "agent/connect", "params": {}, "body": {}})
    assert resp.status_code == 200
    data = resp.json()
    assert "agents" in data


async def test_chat_endpoint_handles_error(client: AsyncClient, monkeypatch):
    """Chat endpoint should emit RUN_ERROR on LLM failure."""
    import adsb_agent.main as main_mod

    async def mock_stream_error(*args, **kwargs):
        raise ConnectionError("LM Studio not running")
        yield  # Make this an async generator (yield never reached)

    monkeypatch.setattr(main_mod, "stream_llm_response", mock_stream_error)

    resp = await client.post(
        "/ag-ui/chat",
        json={
            "threadId": "t1",
            "runId": "r1",
            "messages": [{"id": "m1", "role": "user", "content": "Hi"}],
            "tools": [],
            "context": [],
            "state": {},
            "forwardedProps": {},
        },
    )

    assert resp.status_code == 200
    body = resp.text
    events = [line for line in body.split("\n") if line.startswith("data:")]

    # Should contain RUN_STARTED and RUN_ERROR (no RUN_FINISHED — error is terminal)
    event_types = " ".join(events)
    assert "RUN_STARTED" in event_types
    assert "RUN_ERROR" in event_types
    assert "RUN_FINISHED" not in event_types

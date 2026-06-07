"""RunAgentInput.context (AG-UI Context list) must be forwarded to the LLM layer.

Regression guard for the bug where main.py only forwarded messages + tools and
silently dropped input_data.context — the ambient app-state that CopilotKit
populates via useCopilotReadable on the frontend.
"""

from __future__ import annotations

import pytest
from ag_ui.core import EventType, TextMessageEndEvent, TextMessageStartEvent
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def client():
    from adsb_agent.main import app

    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def test_chat_forwards_frontend_context_to_llm(client: AsyncClient, monkeypatch):
    import adsb_agent.main as main_mod

    captured: dict = {}

    async def mock_stream(*, messages, tools, context):
        captured["context"] = context
        yield TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START, message_id="m", role="assistant"
        )
        yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id="m")

    monkeypatch.setattr(main_mod, "stream_llm_response", mock_stream)

    context_entries = [
        {"description": "Selected aircraft", "value": '{"selected":["A1B2C3"]}'},
        {"description": "Active mode", "value": "live"},
    ]

    resp = await client.post(
        "/ag-ui/chat",
        json={
            "threadId": "t1",
            "runId": "r1",
            "messages": [{"id": "m1", "role": "user", "content": "hi"}],
            "tools": [],
            "context": context_entries,
            "state": {},
            "forwardedProps": {},
        },
    )

    assert resp.status_code == 200
    assert "context" in captured, "stream_llm_response was never called with context kw"
    assert captured["context"] is not None, "context forwarded as None — frontend list dropped"
    assert len(captured["context"]) == 2
    assert captured["context"][0].description == "Selected aircraft"
    assert captured["context"][1].value == "live"

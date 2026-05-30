"""Frontend tools (RunAgentInput.tools) must be forwarded to the LLM, not discarded.

Regression guard for the bug where main.py hardcoded `tools=None` and threw away
the AG-UI Tool list that CopilotKit transmits on every chat turn.
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


async def test_chat_forwards_frontend_tools_to_llm(client: AsyncClient, monkeypatch):
    """tools array on RunAgentInput must reach stream_llm_response, not be replaced with None."""
    import adsb_agent.main as main_mod

    captured: dict = {}

    async def mock_stream(*, messages, tools):
        captured["tools"] = tools
        yield TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START, message_id="m", role="assistant"
        )
        yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id="m")

    monkeypatch.setattr(main_mod, "stream_llm_response", mock_stream)

    frontend_tools = [
        {
            "name": "doFooBar",
            "description": "A tool the frontend just invented.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
    ]

    resp = await client.post(
        "/ag-ui/chat",
        json={
            "threadId": "t1",
            "runId": "r1",
            "messages": [{"id": "m1", "role": "user", "content": "hi"}],
            "tools": frontend_tools,
            "context": [],
            "state": {},
            "forwardedProps": {},
        },
    )

    assert resp.status_code == 200
    assert "tools" in captured, "stream_llm_response was never called"
    assert captured["tools"] is not None, "tools forwarded as None — frontend list dropped"
    assert len(captured["tools"]) == 1
    assert captured["tools"][0].name == "doFooBar"

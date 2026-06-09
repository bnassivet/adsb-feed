"""SSE heartbeat: long silent LLM steps must not let the connection go idle.

Regression for runs cut off mid-stream — a single local-model step can run for
minutes emitting nothing, and the client/proxy idle-timeout aborted the SSE
connection (GeneratorExit cancelling the in-flight LLM read). The agent now
emits an SSE comment heartbeat during gaps; this verifies one is sent while the
run still completes normally.
"""

from __future__ import annotations

import asyncio

import pytest
from ag_ui.core import EventType, TextMessageContentEvent, TextMessageStartEvent
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def client():
    from adsb_agent.main import app

    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def _slow_stream(*, messages, tools, context=None):
    # Stay silent past the (tiny, monkeypatched) heartbeat interval, then answer.
    await asyncio.sleep(0.25)
    yield TextMessageStartEvent(
        type=EventType.TEXT_MESSAGE_START, message_id="m", role="assistant"
    )
    yield TextMessageContentEvent(
        type=EventType.TEXT_MESSAGE_CONTENT, message_id="m", delta="done"
    )


async def test_heartbeat_emitted_during_silent_gap(client: AsyncClient, monkeypatch):
    import adsb_agent.main as main_mod

    monkeypatch.setattr(main_mod.settings, "sse_heartbeat_seconds", 0.05)
    monkeypatch.setattr(main_mod, "stream_llm_response", _slow_stream)

    body = ""
    async with client.stream(
        "POST",
        "/ag-ui/chat",
        json={
            "threadId": "t1",
            "runId": "r1",
            "messages": [{"id": "u1", "role": "user", "content": "hi"}],
            "tools": [],
            "context": [],
            "state": {},
            "forwardedProps": {},
        },
    ) as resp:
        assert resp.status_code == 200
        async for chunk in resp.aiter_text():
            body += chunk

    # A keep-alive heartbeat fired during the 0.25s silent gap...
    assert ": keep-alive" in body
    # ...and the real run still started and finished.
    assert "RUN_STARTED" in body
    assert "RUN_FINISHED" in body
    assert "done" in body

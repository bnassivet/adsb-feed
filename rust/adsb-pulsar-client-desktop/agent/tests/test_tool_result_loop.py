"""Tool-result round-trip: the LLM must see prior `role=tool` messages.

Regression for the bug where the chat would hedge ("no tracks") even after
the frontend executed a tool — guards `_convert_messages` so it always
forwards (a) the assistant message with `tool_calls`, and (b) the matching
tool-result message with the same `tool_call_id` into the OpenAI payload.
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


async def test_chat_forwards_tool_result_message_to_llm(client: AsyncClient, monkeypatch):
    """RunAgentInput.messages that includes assistant+tool_calls and a role=tool
    result must reach stream_llm_response with both intact in the OpenAI payload."""
    import adsb_agent.main as main_mod
    import adsb_agent.llm as llm_mod

    captured_openai_messages: list = []

    # Patch _convert_messages to capture what would be sent to the LLM.
    original_convert = llm_mod._convert_messages

    def spy_convert(messages):
        result = original_convert(messages)
        captured_openai_messages.extend(result)
        return result

    monkeypatch.setattr(llm_mod, "_convert_messages", spy_convert)

    async def mock_stream(*, messages, tools, context=None):
        # Force the real _convert_messages to run by calling it directly through
        # the spy — emulate the actual codepath up to the LLM boundary.
        llm_mod._convert_messages(messages)
        yield TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START, message_id="m", role="assistant"
        )
        yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id="m")

    monkeypatch.setattr(main_mod, "stream_llm_response", mock_stream)

    # Construct an AG-UI message history representing a completed turn-1:
    #   user → assistant(tool_calls) → tool(result)
    resp = await client.post(
        "/ag-ui/chat",
        json={
            "threadId": "t1",
            "runId": "r2",
            "messages": [
                {"id": "u1", "role": "user", "content": "how many active flights?"},
                {
                    "id": "a1",
                    "role": "assistant",
                    "content": "",
                    "toolCalls": [
                        {
                            "id": "tc-1",
                            "type": "function",
                            "function": {
                                "name": "searchLiveFlights",
                                "arguments": "{}",
                            },
                        }
                    ],
                },
                {
                    "id": "tr1",
                    "role": "tool",
                    "toolCallId": "tc-1",
                    "content": '{"total":3,"showing":3,"flights":[{"hex_ident":"A1B2C3"}]}',
                },
            ],
            "tools": [],
            "context": [],
            "state": {},
            "forwardedProps": {},
        },
    )

    assert resp.status_code == 200

    # Find the tool message in the OpenAI payload — must carry tool_call_id and
    # the original JSON content verbatim, otherwise the LLM has no idea what
    # the tool returned.
    tool_msgs = [m for m in captured_openai_messages if m.get("role") == "tool"]
    assert len(tool_msgs) == 1, f"expected 1 tool msg, got {captured_openai_messages}"
    assert tool_msgs[0]["tool_call_id"] == "tc-1"
    assert "A1B2C3" in tool_msgs[0]["content"]

    # The preceding assistant message must carry tool_calls — OpenAI's API
    # rejects a tool message that doesn't follow an assistant with matching id.
    assistant_msgs = [m for m in captured_openai_messages if m.get("role") == "assistant"]
    assert any(
        m.get("tool_calls") and m["tool_calls"][0]["id"] == "tc-1"
        for m in assistant_msgs
    ), f"no assistant message carrying tool_calls in {captured_openai_messages}"

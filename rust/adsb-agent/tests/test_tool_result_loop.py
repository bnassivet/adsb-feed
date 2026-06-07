"""Tool-result round-trip: the LLM must see prior `role=tool` messages.

Regression for the bug where the chat would hedge ("no tracks") even after the
frontend executed a tool. The agent reconstructs the conversation for the LLM via
`graph.convert_agui_messages_to_lc`, which must forward (a) the assistant message
with `tool_calls`, and (b) the matching tool-result message with the same
`tool_call_id` — otherwise the model has no idea what the tool returned and the
LLM API rejects an orphaned tool message.
"""

from __future__ import annotations

from ag_ui.core import RunAgentInput
from langchain_core.messages import AIMessage, ToolMessage

from adsb_agent.graph import convert_agui_messages_to_lc


def _turn1_history() -> RunAgentInput:
    """A completed turn-1: user → assistant(tool_calls) → tool(result)."""
    return RunAgentInput(
        thread_id="t1",
        run_id="r2",
        messages=[
            {"id": "u1", "role": "user", "content": "how many active flights?"},
            {
                "id": "a1",
                "role": "assistant",
                "content": "",
                "toolCalls": [
                    {
                        "id": "tc-1",
                        "type": "function",
                        "function": {"name": "searchLiveFlights", "arguments": "{}"},
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
        tools=[],
        context=[],
        state={},
        forwarded_props={},
    )


def test_tool_result_and_assistant_call_survive_conversion():
    lc = convert_agui_messages_to_lc(_turn1_history().messages)

    # The tool message must carry tool_call_id and the original JSON verbatim.
    tool_msgs = [m for m in lc if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1, f"expected 1 tool msg, got {lc}"
    assert tool_msgs[0].tool_call_id == "tc-1"
    assert "A1B2C3" in tool_msgs[0].content

    # The preceding assistant message must carry the matching tool_call — the LLM
    # API rejects a tool message that doesn't follow an assistant with that id.
    assistant_msgs = [m for m in lc if isinstance(m, AIMessage)]
    assert any(
        m.tool_calls and m.tool_calls[0]["id"] == "tc-1" for m in assistant_msgs
    ), f"no assistant message carrying tool_calls in {lc}"

"""Agent entry point — drives the LangGraph ReAct loop, emitting AG-UI events.

`stream_llm_response` keeps the same signature and async-generator-of-AG-UI-events
contract it always had, so `main.py::_run_agent` is unchanged. Internally it now
builds a per-request LangGraph agent (see `graph.py`) that can chain server-side
data tools before answering, instead of making a single LLM call.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from ag_ui.core import EventType, RunErrorEvent
from langchain_core.messages import SystemMessage

from .graph import build_agent_graph, convert_agui_messages_to_lc, run_graph_to_agui
from .system_prompt import render_system_prompt


async def stream_llm_response(
    messages: list,
    tools: list | None = None,
    context: list | None = None,
) -> AsyncIterator:
    """Run the agent for one turn, yielding AG-UI event objects.

    Args:
        messages: AG-UI message objects from RunAgentInput.
        tools: Tool definitions from the frontend. Partitioned into server-executed
            (chained internally) and client-executed (forwarded) tools in `graph.py`.
        context: AG-UI Context entries — ambient UI state injected into the
            system prompt.
    """
    try:
        lc_messages = [SystemMessage(content=render_system_prompt(tools, context))]
        lc_messages.extend(convert_agui_messages_to_lc(messages))
        graph = build_agent_graph(tools)
    except Exception as e:  # noqa: BLE001 — never crash the SSE stream
        yield RunErrorEvent(type=EventType.RUN_ERROR, message=str(e))
        return

    async for event in run_graph_to_agui(graph, lc_messages):
        yield event

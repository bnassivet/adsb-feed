"""Agent entry point — drives the LangGraph ReAct loop, emitting AG-UI events.

`stream_llm_response` keeps the same signature and async-generator-of-AG-UI-events
contract it always had, so `main.py::_run_agent` is unchanged. Internally it now
builds a per-request LangGraph agent (see `graph.py`) that can chain server-side
data tools before answering, instead of making a single LLM call.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

from ag_ui.core import (
    EventType,
    RunErrorEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)
from langchain_core.messages import HumanMessage, SystemMessage

from . import metrics
from .config import settings
from .fast_path import is_fast_path_closing, try_fast_path
from .graph import (
    _forward_tool_calls,
    build_agent_graph,
    convert_agui_messages_to_lc,
    run_graph_to_agui,
)
from .server_tools import effective_tools
from .system_prompt import attach_context, render_system_prompt
from .tool_ranker import select_tools


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
        context: AG-UI Context entries — ambient UI state, placed per
            ``settings.context_placement``.
    """
    # The desktop fast path comes first: a direct display command is carried
    # out by a small model and the main agent is never built. See fast_path.py.
    if settings.fast_path_enabled:
        if is_fast_path_closing(messages):
            # The action already ran in the browser; nothing is left to decide.
            metrics.FAST_PATH_DECISIONS.labels(outcome="closed").inc()
            for event in _confirmation_events():
                yield event
            return
        decision = await try_fast_path(messages, effective_tools(tools))
        if decision.calls:
            for event in _forward_tool_calls(decision.calls, str(uuid.uuid4()), False):
                yield event
            return

    try:
        # One ranking decision per run, shared by the prompt and the graph so
        # the capabilities the prompt lists are the tools actually bound. When
        # the ranker is off or fails, nothing is passed down and both take
        # exactly the path they took before it existed.
        selection = await select_tools(effective_tools(tools), messages)
        bound = selection.tools if selection.fallback is None else None

        history = convert_agui_messages_to_lc(messages)
        # Anything that changes between turns must come after everything that
        # does not, or the model server reprocesses the whole prompt. With
        # "user" placement the system prompt is the same on every turn and the
        # UI state rides on the latest user message. Without a user message to
        # carry it, it stays in the system prompt rather than being dropped.
        on_user = settings.context_placement == "user" and any(
            isinstance(m, HumanMessage) for m in history
        )
        if on_user:
            history = attach_context(history, context)
        system = render_system_prompt(tools, None if on_user else context, bound_tools=bound)
        lc_messages = [SystemMessage(content=system), *history]
        graph = build_agent_graph(tools, bound_tools=bound)
    except Exception as e:  # noqa: BLE001 — never crash the SSE stream
        yield RunErrorEvent(type=EventType.RUN_ERROR, message=str(e))
        return

    async for event in run_graph_to_agui(graph, lc_messages):
        yield event


def _confirmation_events():
    """The fixed reply after a fast-path action, as one assistant message."""
    message_id = str(uuid.uuid4())
    yield TextMessageStartEvent(
        type=EventType.TEXT_MESSAGE_START, message_id=message_id, role="assistant"
    )
    yield TextMessageContentEvent(
        type=EventType.TEXT_MESSAGE_CONTENT,
        message_id=message_id,
        delta=settings.fast_path_confirmation or "Done.",  # a delta may not be empty
    )
    yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id)

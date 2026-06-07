"""LangGraph ReAct agent for the ADS-B assistant.

This replaces the previous single-shot LLM call with a real server-side
reasoning loop. The agent can chain read-only **data tools** internally (via the
Tauri localhost tool server) before answering — true multi-hop reasoning without
round-tripping each hop through the frontend.

Tool plane split
----------------
* **Server tools** (``SERVER_TOOL_NAMES``): executed in-loop. Most are proxied to
  the Tauri tool server over HTTP; ``getCurrentDateTime`` is resolved locally.
  These never reach the graph's END state — they are executed and looped back.
* **Client tools**: every other tool the frontend registered (UI side effects,
  sensitive mutations). The model may *choose* them; when it does, the graph ends
  and the tool call is forwarded to the frontend as AG-UI events (the existing
  CopilotKit round-trip), preserving user-in-the-loop control.

The graph topology:

    START → agent → (route)
                     ├── server_tools → agent   (pure server tool calls)
                     └── END                     (client tool calls, or final text)
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import Any, Iterable

import httpx
from ag_ui.core import (
    EventType,
    RunErrorEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
)

from .config import settings
from .tracing import make_span

logger = logging.getLogger("adsb_agent.graph")

# Tools executed inside the reasoning loop (the DuckDB-backed data plane plus the
# local clock). Must match the routes exposed by the Tauri `tool_server.rs`
# (except getCurrentDateTime, which is resolved locally).
SERVER_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "getStorageStats",
        "getAircraftSummary",
        "getFlightSummary",
        "getTrajectory",
        "getTimeDistribution",
        "getHourlyHeatmap",
        "getEventsOfInterest",
        "getCurrentDateTime",
    }
)

_CAMEL_RE = re.compile(r"(?<!^)(?=[A-Z])")


def _camel_to_snake(name: str) -> str:
    """``startMs`` → ``start_ms`` (matches the snake_case data-engine structs)."""
    return _CAMEL_RE.sub("_", name).lower()


def partition_tool_names(tools: Iterable[Any] | None) -> tuple[set[str], set[str]]:
    """Split frontend-supplied tools into (server-executed, client-executed) names.

    A tool is server-executed iff its name is in ``SERVER_TOOL_NAMES``; everything
    else is forwarded to the client. When ``tools`` is None/empty, the server set
    is the full known server surface (CLI/test fallback) and client set is empty.
    """
    if not tools:
        return set(SERVER_TOOL_NAMES), set()
    names = {getattr(t, "name", None) for t in tools}
    names.discard(None)
    server = {n for n in names if n in SERVER_TOOL_NAMES}
    client = {n for n in names if n not in SERVER_TOOL_NAMES}
    return server, client


def transform_server_args(args: dict[str, Any]) -> dict[str, Any]:
    """Map the LLM's camelCase tool args to the snake_case the Tauri endpoint wants.

    Also lowercases the ``metric`` enum value (the frontend schema uses PascalCase
    like ``Positions`` but the Rust ``TimeDistributionMetric`` is snake_case).
    """
    out: dict[str, Any] = {}
    for key, value in (args or {}).items():
        snake = _camel_to_snake(key)
        if snake == "metric" and isinstance(value, str):
            value = _camel_to_snake(value)
        out[snake] = value
    return out


def _current_datetime_payload() -> dict[str, Any]:
    now = datetime.now(timezone.utc).astimezone()
    return {
        "iso": now.isoformat(),
        "epoch_ms": int(now.timestamp() * 1000),
        "timezone": str(now.tzinfo),
    }


async def execute_server_tool(
    name: str,
    args: dict[str, Any],
    client: httpx.AsyncClient,
) -> str:
    """Execute one server tool, returning a string suitable for a ToolMessage.

    ``getCurrentDateTime`` is resolved locally. Everything else is POSTed to the
    Tauri tool server. Transport/HTTP failures and ``ok:false`` envelopes are
    returned as readable error strings so the model can react instead of crashing.

    The whole execution is wrapped in a ``TOOL``-type MLflow span so each tool
    call appears nested under the active ``chat_turn`` root in the trace, with
    the args as inputs and the result/error as outputs.
    """
    with make_span(f"tool.{name}", span_type="TOOL") as span:
        if span is not None:
            span.set_inputs({"name": name, "args": args})
        result = await _execute_server_tool_inner(name, args, client)
        if span is not None:
            span.set_outputs({"result": result})
        return result


async def _execute_server_tool_inner(
    name: str,
    args: dict[str, Any],
    client: httpx.AsyncClient,
) -> str:
    """Run one server tool and return its string result (see execute_server_tool)."""
    if name == "getCurrentDateTime":
        return json.dumps(_current_datetime_payload())

    url = f"{settings.tool_server_url.rstrip('/')}/tools/{name}"
    body = transform_server_args(args)
    try:
        resp = await client.post(url, json=body, timeout=settings.tool_server_timeout)
        resp.raise_for_status()
        envelope = resp.json()
    except Exception as e:  # noqa: BLE001 — surface any failure to the model
        logger.warning("Server tool %s failed: %s", name, e)
        return f"Error calling {name}: {e}"

    if envelope.get("ok"):
        return json.dumps(envelope.get("data"))
    return f"Error: {envelope.get('error', 'unknown error')}"


def _to_openai_tools(tools: Iterable[Any] | None) -> list[dict] | None:
    """AG-UI Tool objects → OpenAI function-calling schemas for ``bind_tools``."""
    if not tools:
        return None
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters or {"type": "object", "properties": {}},
            },
        }
        for t in tools
    ]


def convert_agui_messages_to_lc(messages: Iterable[Any]) -> list[Any]:
    """Convert AG-UI message objects to LangChain message objects."""
    from langchain_core.messages import (
        AIMessage,
        HumanMessage,
        SystemMessage,
        ToolMessage,
    )

    result: list[Any] = []
    for msg in messages:
        role = msg.role
        content = getattr(msg, "content", None) or ""
        if role == "system":
            result.append(SystemMessage(content=content))
        elif role == "tool":
            result.append(
                ToolMessage(
                    content=content,
                    tool_call_id=getattr(msg, "tool_call_id", "") or "",
                )
            )
        elif role == "assistant":
            tool_calls = []
            for tc in getattr(msg, "tool_calls", None) or []:
                fn = getattr(tc, "function", None)
                raw_args = getattr(fn, "arguments", "") if fn else ""
                try:
                    parsed = json.loads(raw_args) if raw_args else {}
                except json.JSONDecodeError:
                    parsed = {}
                tool_calls.append(
                    {
                        "name": fn.name if fn else "",
                        "args": parsed,
                        "id": getattr(tc, "id", "") or "",
                    }
                )
            result.append(AIMessage(content=content, tool_calls=tool_calls))
        else:  # user or unknown → treat as human
            result.append(HumanMessage(content=content))
    return result


def build_agent_graph(tools: Iterable[Any] | None, *, model: Any | None = None):
    """Compile a per-request LangGraph ReAct agent.

    A fresh graph is built per turn because the available tool surface arrives
    with each request (``RunAgentInput.tools``). Compilation is cheap.

    ``model`` lets tests inject a fake chat model (returning canned ``AIMessage``s)
    so the node-span instrumentation can be exercised without a live LLM. In
    production it is None and a ``ChatOpenAI`` is constructed from settings.
    """
    from langchain_core.messages import ToolMessage
    from langgraph.graph import END, START, StateGraph, MessagesState

    schemas = _to_openai_tools(tools)
    server_names, _client_names = partition_tool_names(tools)

    if model is None:
        from langchain_openai import ChatOpenAI

        model = ChatOpenAI(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            model=settings.model,
            temperature=settings.temperature,
            max_tokens=settings.max_tokens,
        )
        model = model.bind_tools(schemas) if schemas else model

    async def agent_node(state: dict) -> dict:
        # Manual span so the openai-autolog LLM call (`AsyncCompletions`) nests
        # under it via the fluent context (langchain autolog is intentionally off).
        with make_span("agent", span_type="AGENT"):
            response = await model.ainvoke(state["messages"])
        return {"messages": [response]}

    async def server_tools_node(state: dict) -> dict:
        last = state["messages"][-1]
        results: list[Any] = []
        with make_span("server_tools", span_type="CHAIN"):
            async with httpx.AsyncClient() as client:
                for tc in getattr(last, "tool_calls", None) or []:
                    if tc["name"] in server_names:
                        content = await execute_server_tool(
                            tc["name"], tc.get("args", {}), client
                        )
                        results.append(ToolMessage(content=content, tool_call_id=tc["id"]))
        return {"messages": results}

    def route(state: dict) -> str:
        last = state["messages"][-1]
        tool_calls = getattr(last, "tool_calls", None) or []
        # Only loop into server execution when EVERY pending call is server-side.
        # Mixed/any client calls fall through to END to be forwarded.
        if tool_calls and all(tc["name"] in server_names for tc in tool_calls):
            return "server_tools"
        return END

    graph = StateGraph(MessagesState)
    graph.add_node("agent", agent_node)
    graph.add_node("server_tools", server_tools_node)
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", route, {"server_tools": "server_tools", END: END})
    graph.add_edge("server_tools", "agent")
    return graph.compile()


def _dev_tools() -> list[Any]:
    """Adapt the fallback OpenAI-format ``TOOLS`` into objects with the
    ``.name``/``.description``/``.parameters`` attributes ``build_agent_graph``
    expects (the same shape as AG-UI Tool objects)."""
    from types import SimpleNamespace

    from .tools import TOOLS

    return [
        SimpleNamespace(
            name=t["function"]["name"],
            description=t["function"]["description"],
            parameters=t["function"].get("parameters", {}),
        )
        for t in TOOLS
    ]


def make_graph(config: Any | None = None):
    """Entry point for ``langgraph dev`` / langgraph-cli (see ``langgraph.json``).

    In LangGraph Studio there is no frontend supplying ``RunAgentInput.tools``, so
    the graph is built with the dev fallback tool surface (``tools.py``). Server
    data tools still proxy to the Tauri tool server (run the desktop app, or set
    ``ADSB_AGENT_TOOL_SERVER_URL``); UI/action tools surface as forwarded tool
    calls. ``config`` is accepted for langgraph-cli compatibility and unused.
    """
    return build_agent_graph(_dev_tools())


async def run_graph_to_agui(graph, lc_messages: list[Any]) -> AsyncIterator:
    """Drive a compiled graph and translate its stream into AG-UI events.

    Streams assistant text token-by-token, then forwards any client tool calls
    present on the final message (server tool calls have already been executed
    and looped, so they never survive to the end state).
    """
    message_id = str(uuid.uuid4())
    text_started = False
    final_messages: list[Any] = lc_messages

    try:
        async for mode, chunk in graph.astream(
            {"messages": lc_messages},
            stream_mode=["messages", "values"],
            config={"recursion_limit": settings.agent_recursion_limit},
        ):
            if mode == "messages":
                msg_chunk, _meta = chunk
                content = getattr(msg_chunk, "content", "") or ""
                if content:
                    if not text_started:
                        yield TextMessageStartEvent(
                            type=EventType.TEXT_MESSAGE_START,
                            message_id=message_id,
                            role="assistant",
                        )
                        text_started = True
                    yield TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=message_id,
                        delta=content,
                    )
            elif mode == "values":
                final_messages = chunk.get("messages", final_messages)
    except Exception as e:  # noqa: BLE001
        logger.error("Graph execution error: %s", e, exc_info=True)
        yield RunErrorEvent(type=EventType.RUN_ERROR, message=str(e))
        return

    if text_started:
        yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id)

    # Forward client tool calls (if any) from the final assistant message.
    last = final_messages[-1] if final_messages else None
    tool_calls = getattr(last, "tool_calls", None) or []
    if tool_calls and not text_started:
        # AG-UI needs an assistant message envelope to attach tool calls to, so
        # the reconstructed history on the next runAgent can pair tool results
        # with their originating call (mirrors the previous llm.py behavior).
        yield TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START,
            message_id=message_id,
            role="assistant",
        )
        yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id)

    for tc in tool_calls:
        # Client tools execute in the browser (CopilotKit round-trip), so the
        # result isn't available here — but record a TOOL span for the forwarded
        # call so it's visible in the trace alongside server-executed tools.
        with make_span(f"tool.{tc['name']}", span_type="TOOL") as span:
            if span is not None:
                span.set_inputs({"name": tc["name"], "args": tc.get("args", {})})
                span.set_outputs({"forwarded_to_client": True})
        yield ToolCallStartEvent(
            type=EventType.TOOL_CALL_START,
            tool_call_id=tc["id"],
            tool_call_name=tc["name"],
            parent_message_id=message_id,
        )
        yield ToolCallArgsEvent(
            type=EventType.TOOL_CALL_ARGS,
            tool_call_id=tc["id"],
            delta=json.dumps(tc.get("args", {})),
        )
        yield ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=tc["id"])

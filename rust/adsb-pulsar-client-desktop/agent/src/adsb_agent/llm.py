"""LLM client — OpenAI-compatible async streaming (works with LM Studio, Ollama, OpenAI, etc.)

Converts OpenAI streaming chunks into AG-UI events.
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
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
)
from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionChunk

from .config import settings
from .system_prompt import render_system_prompt
from .tools import TOOLS

# Reuse a single client instance (connection pooling)
_client: AsyncOpenAI | None = None


def get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(base_url=settings.llm_base_url, api_key=settings.llm_api_key)
    return _client


def _convert_messages(messages: list) -> list[dict]:
    """Convert AG-UI messages to OpenAI message format."""
    result: list[dict] = []
    for msg in messages:
        if msg.role == "tool":
            result.append({
                "role": "tool",
                "tool_call_id": msg.tool_call_id if hasattr(msg, "tool_call_id") else "",
                "content": msg.content or "",
            })
        elif msg.role == "assistant":
            entry: dict = {"role": "assistant", "content": msg.content or ""}
            if hasattr(msg, "tool_calls") and msg.tool_calls:
                entry["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name if tc.function else "",
                            "arguments": tc.function.arguments if tc.function else "",
                        },
                    }
                    for tc in msg.tool_calls
                ]
            result.append(entry)
        else:
            result.append({"role": msg.role, "content": msg.content or ""})
    return result


def _to_openai_tools(tools: list) -> list[dict]:
    """Convert AG-UI Tool objects to OpenAI function-calling format."""
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


async def stream_llm_response(
    messages: list,
    tools: list | None = None,
    context: list | None = None,
) -> AsyncIterator:
    """Stream LLM response, yielding AG-UI event objects.

    Args:
        messages: AG-UI message objects from RunAgentInput.
        tools: Optional tool definitions. If None, uses the default TOOLS.
        context: Optional AG-UI Context entries — ambient UI state to inject
            into the system prompt. Empty/None → no Ambient context section.
    """
    client = get_client()

    openai_messages = [
        {"role": "system", "content": render_system_prompt(tools, context)}
    ]
    openai_messages.extend(_convert_messages(messages))

    tool_defs = _to_openai_tools(tools) if tools else TOOLS

    try:
        stream = await client.chat.completions.create(
            model=settings.model,
            messages=openai_messages,
            tools=tool_defs if tool_defs else None,
            stream=True,
            max_tokens=settings.max_tokens,
            temperature=settings.temperature,
        )
    except Exception as e:
        yield RunErrorEvent(type=EventType.RUN_ERROR, message=str(e))
        return

    message_id = str(uuid.uuid4())
    text_started = False
    # Track active tool calls: {index: {id, name, started}}
    active_tool_calls: dict[int, dict] = {}

    async for chunk in stream:
        chunk: ChatCompletionChunk
        if not chunk.choices:
            continue

        delta = chunk.choices[0].delta

        # --- Text content ---
        if delta.content:
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
                delta=delta.content,
            )

        # --- Tool calls ---
        if delta.tool_calls:
            for tc in delta.tool_calls:
                idx = tc.index

                # New tool call
                if idx not in active_tool_calls:
                    tool_call_id = tc.id or str(uuid.uuid4())
                    tool_name = tc.function.name if tc.function else ""
                    active_tool_calls[idx] = {
                        "id": tool_call_id,
                        "name": tool_name,
                        "started": False,
                    }

                info = active_tool_calls[idx]

                # Update name if provided in this chunk
                if tc.function and tc.function.name:
                    info["name"] = tc.function.name

                # Update id if provided
                if tc.id:
                    info["id"] = tc.id

                # Emit start event once we have a name
                if not info["started"] and info["name"]:
                    # Close any open text message first
                    if text_started:
                        yield TextMessageEndEvent(
                            type=EventType.TEXT_MESSAGE_END,
                            message_id=message_id,
                        )
                        text_started = False
                    elif not any(i["started"] for i in active_tool_calls.values()):
                        # First emission of the run is a tool call (LLM went
                        # straight to the tool with no preamble text). Emit an
                        # empty TEXT_MESSAGE envelope so the AG-UI client has
                        # an assistant message of `message_id` to attach the
                        # tool_calls to — otherwise the reconstructed message
                        # history on the next runAgent may lack the assistant
                        # message that owns this tool call, and CopilotKit /
                        # the LLM API will be unable to pair the tool result
                        # with its originating tool_call.
                        yield TextMessageStartEvent(
                            type=EventType.TEXT_MESSAGE_START,
                            message_id=message_id,
                            role="assistant",
                        )
                        yield TextMessageEndEvent(
                            type=EventType.TEXT_MESSAGE_END,
                            message_id=message_id,
                        )

                    yield ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=info["id"],
                        tool_call_name=info["name"],
                        parent_message_id=message_id,
                    )
                    info["started"] = True

                # Stream arguments
                if tc.function and tc.function.arguments:
                    yield ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=info["id"],
                        delta=tc.function.arguments,
                    )

        # --- Finish reason ---
        if chunk.choices[0].finish_reason:
            # Close open text message
            if text_started:
                yield TextMessageEndEvent(
                    type=EventType.TEXT_MESSAGE_END,
                    message_id=message_id,
                )
                text_started = False

            # Close open tool calls
            for info in active_tool_calls.values():
                if info["started"]:
                    yield ToolCallEndEvent(
                        type=EventType.TOOL_CALL_END,
                        tool_call_id=info["id"],
                    )

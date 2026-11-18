"""Dynamic system prompt rendering.

The agent's system prompt is built per request from:
  - prompt_sections.yaml — intro, data conventions, guidelines (hand-edited prose)
  - the agent's own backend tools (server_tools.py), always
  - the client tools the frontend sent over the wire as RunAgentInput.tools

This eliminates a long-standing drift surface where a hand-written SYSTEM_PROMPT
listed capabilities that no longer matched the actual tool surface. Each half
has one source of truth: server_tools.py for backend tools, useCopilotTools.ts
for client tools. This module just reflects them.

CLI / unit-test paths that don't supply tools fall back to the dev TOOLS list
in tools.py so the prompt stays usable for offline development.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Iterable

import yaml
from jinja2 import Environment, FileSystemLoader, StrictUndefined

from .server_tools import effective_tools

logger = logging.getLogger(__name__)

_MODULE_DIR = Path(__file__).parent
_SECTIONS_PATH = _MODULE_DIR / "prompt_sections.yaml"
_TEMPLATE_NAME = "system_prompt.md.j2"


def _load_sections() -> dict[str, Any]:
    with _SECTIONS_PATH.open() as f:
        return yaml.safe_load(f)


_env = Environment(
    loader=FileSystemLoader(str(_MODULE_DIR)),
    undefined=StrictUndefined,
    keep_trailing_newline=True,
)
_template = _env.get_template(_TEMPLATE_NAME)
_sections = _load_sections()


def _first_sentence(text: str) -> str:
    """Return the first sentence of a description; falls back to the whole string."""
    stripped = text.strip()
    for terminator in (". ", ".\n"):
        idx = stripped.find(terminator)
        if idx != -1:
            return stripped[: idx + 1].strip()
    return stripped


def _capabilities_from_agui_tools(tools: Iterable[Any]) -> list[str]:
    """Tool objects from RunAgentInput.tools — pydantic models with .description."""
    out: list[str] = []
    for t in tools:
        desc = getattr(t, "description", None) or ""
        if desc:
            out.append(_first_sentence(desc))
    return out


def _capabilities_from_dev_tools() -> list[str]:
    """Fallback: read descriptions out of the hardcoded TOOLS list in tools.py."""
    from .tools import TOOLS  # local import to avoid cycle at module load

    return [_first_sentence(t["function"]["description"]) for t in TOOLS]


def _format_context(context: Iterable[Any] | None) -> list[str]:
    """Render AG-UI Context entries as bullet lines.

    Each entry becomes `**{description}:** {value}`. Empty descriptions and
    empty values are skipped so the LLM never sees blank bullets.
    """
    if not context:
        return []
    out: list[str] = []
    for c in context:
        desc = (getattr(c, "description", None) or "").strip()
        value = getattr(c, "value", None)
        if value is None:
            continue
        if not isinstance(value, str):
            value = str(value)
        value = value.strip()
        if not desc or not value:
            continue
        out.append(f"**{desc}:** {value}")
    return out


def attach_context(messages: list[Any], context: Iterable[Any] | None) -> list[Any]:
    """Put the ambient UI state on the latest user message.

    The model server reuses the previous prompt only up to the first character
    that differs, and UI state changes between turns. In the system prompt it
    sat ahead of ~7k tokens of instructions and tool schemas and forced all of
    them to be reprocessed (17 s to first token against 0.4 s, see
    ``eval/cache_experiment.py``). On the latest user message it sits after
    everything that is stable.

    Only the **latest** user message carries it: earlier turns must read the
    same on every later run, or the history stops being a reusable prefix.
    That is the last *user* message, not the last message -- a client tool
    result re-enters as a run that ends with the tool message.

    Returns a new list; the input messages are not modified. With no usable
    state or no user message, the messages come back unchanged.
    """
    from langchain_core.messages import HumanMessage

    entries = _format_context(context)
    if not entries:
        return list(messages)
    out = list(messages)
    for i in range(len(out) - 1, -1, -1):
        msg = out[i]
        if isinstance(msg, HumanMessage) and isinstance(msg.content, str):
            bullets = "\n".join(f"- {e}" for e in entries)
            out[i] = HumanMessage(
                content=(
                    "## Current UI state (ambient, refreshed each turn)\n"
                    f"{bullets}\n\n## Request\n{msg.content}"
                )
            )
            break
    return out


def render_system_prompt(
    tools: Iterable[Any] | None,
    context: Iterable[Any] | None = None,
    *,
    bound_tools: Iterable[Any] | None = None,
) -> str:
    """Render the system prompt for the current chat turn.

    Args:
        tools: AG-UI Tool objects from RunAgentInput.tools (client-supplied).
               The agent's backend tools (``server_tools.py``) are always
               listed in addition; a client copy of one is ignored.
               If None or empty, falls back to the dev TOOLS list so CLI and
               unit-test invocations still produce a usable prompt.
        context: AG-UI Context entries from RunAgentInput.context — ambient
               UI state the LLM should know without making a tool call.
               If None or empty, the "Ambient context" section is omitted.
        bound_tools: the tool ranker's selection, when it made one. The
               "What you can do" list then describes exactly the tools the
               model can call this turn, instead of the whole surface.
    """
    # Backend tools are the agent's own and always present; the client's tools
    # are appended. With no client tools at all (CLI/tests) the dev list below
    # is used instead, which already includes the backend tools.
    if bound_tools is not None:
        capabilities = _capabilities_from_agui_tools(bound_tools)
    else:
        capabilities = _capabilities_from_agui_tools(effective_tools(tools)) if tools else []
    if not capabilities:
        logger.warning(
            "render_system_prompt: no frontend tools supplied, "
            "falling back to dev TOOLS list"
        )
        capabilities = _capabilities_from_dev_tools()

    context_entries = _format_context(context)

    return _template.render(
        intro=_sections["intro"],
        tool_capabilities=capabilities,
        context_entries=context_entries,
        data_conventions=_sections["data_conventions"],
        guidelines=_sections["guidelines"],
    )

"""Dynamic system prompt rendering.

The agent's system prompt is built per request from:
  - prompt_sections.yaml — intro, data conventions, guidelines (hand-edited prose)
  - the tools the frontend sent over the wire as RunAgentInput.tools

This eliminates a long-standing drift surface where a hand-written SYSTEM_PROMPT
listed capabilities that no longer matched the actual TOOLS / frontend
registrations. The frontend (useCopilotTools.ts) is now the single source of
truth for the tool surface; this module just reflects what arrived.

CLI / unit-test paths that don't supply tools fall back to the dev TOOLS list
in tools.py so the prompt stays usable for offline development.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Iterable

import yaml
from jinja2 import Environment, FileSystemLoader, StrictUndefined

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


def render_system_prompt(
    tools: Iterable[Any] | None,
    context: Iterable[Any] | None = None,
) -> str:
    """Render the system prompt for the current chat turn.

    Args:
        tools: AG-UI Tool objects from RunAgentInput.tools (frontend-supplied).
               If None or empty, falls back to the dev TOOLS list so CLI and
               unit-test invocations still produce a usable prompt.
        context: AG-UI Context entries from RunAgentInput.context — ambient
               UI state the LLM should know without making a tool call.
               If None or empty, the "Ambient context" section is omitted.
    """
    capabilities = _capabilities_from_agui_tools(tools) if tools else []
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

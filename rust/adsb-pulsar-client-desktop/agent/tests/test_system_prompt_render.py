"""render_system_prompt builds the system prompt dynamically from incoming tools.

Capability bullets come from the tool list received over the wire; non-tool
prose comes from prompt_sections.yaml. Empty/None tools fall back to the dev
TOOLS list so CLI invocations still get a usable prompt.
"""

from __future__ import annotations

from ag_ui.core import Tool

from adsb_agent.system_prompt import render_system_prompt


def _tool(name: str, description: str) -> Tool:
    return Tool(name=name, description=description, parameters={"type": "object", "properties": {}})


def test_render_includes_capability_for_each_tool():
    tools = [
        _tool("doFooBar", "Do the foo-bar thing for the user."),
        _tool("queryBaz", "Query the baz database for results."),
    ]
    prompt = render_system_prompt(tools)

    assert "foo-bar" in prompt.lower()
    assert "baz database" in prompt.lower()


def test_render_includes_yaml_prose_verbatim():
    prompt = render_system_prompt([_tool("noop", "Does nothing.")])

    # Sentinel substrings from prompt_sections.yaml — assert they survive the render.
    assert "milliseconds since Unix epoch" in prompt
    assert "feet, ground speed in knots" in prompt
    assert "Only start/stop the feed when explicitly asked" in prompt


def test_render_intro_present():
    prompt = render_system_prompt([_tool("noop", "Does nothing.")])
    assert "ADS-B" in prompt
    assert "aircraft" in prompt.lower()


def test_empty_tools_falls_back_to_dev_tools():
    """No frontend tools (CLI/test path) → capabilities populated from dev TOOLS."""
    prompt = render_system_prompt([])

    from adsb_agent.tools import TOOLS

    # The dev TOOLS list should provide at least one well-known capability.
    known_names = {t["function"]["name"] for t in TOOLS}
    assert "getStorageStats" in known_names  # sanity: dev list still exists
    # Capability text should mention something from a real tool's description.
    assert "storage" in prompt.lower() or "database" in prompt.lower()


def test_render_returns_non_empty_string():
    prompt = render_system_prompt([_tool("noop", "Does nothing.")])
    assert isinstance(prompt, str)
    assert len(prompt) > 100

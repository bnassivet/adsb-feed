"""render_system_prompt builds the system prompt dynamically from incoming tools.

Capability bullets come from the tool list received over the wire; non-tool
prose comes from prompt_sections.yaml. Empty/None tools fall back to the dev
TOOLS list so CLI invocations still get a usable prompt.
"""

from __future__ import annotations

from ag_ui.core import Context, Tool

from adsb_agent.system_prompt import render_system_prompt


def _tool(name: str, description: str) -> Tool:
    return Tool(name=name, description=description, parameters={"type": "object", "properties": {}})


def _ctx(description: str, value: str) -> Context:
    return Context(description=description, value=value)


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
    assert "Never answer count questions from prior knowledge" in prompt


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


def test_render_includes_context_entries():
    prompt = render_system_prompt(
        [_tool("noop", "Does nothing.")],
        context=[
            _ctx("Selected aircraft", '{"selected":["A1B2C3"]}'),
            _ctx("Active mode", "live"),
        ],
    )
    assert "Ambient context" in prompt
    assert "Selected aircraft" in prompt
    assert "A1B2C3" in prompt
    assert "Active mode" in prompt
    assert "live" in prompt


def test_render_omits_ambient_section_when_no_context():
    """Empty/None context → no stub heading."""
    assert "Ambient context" not in render_system_prompt(
        [_tool("noop", "Does nothing.")], context=None
    )
    assert "Ambient context" not in render_system_prompt(
        [_tool("noop", "Does nothing.")], context=[]
    )


def test_backend_tool_capabilities_are_listed_when_the_client_sends_only_its_own():
    """Backend tools are the agent's own (server_tools.py), so the prompt must
    advertise them even though the desktop no longer sends their schemas."""
    prompt = render_system_prompt([_tool("panMapTo", "Pan the map to a location.")])

    assert "pan the map" in prompt.lower()
    assert "database overview" in prompt.lower()  # getStorageStats
    assert "simulated aircraft" in prompt.lower()  # generateSimulatedTrajectory


def test_a_client_copy_of_a_backend_tool_is_not_listed_twice():
    stale = _tool("getStorageStats", "Stale frontend copy of the storage tool.")
    prompt = render_system_prompt([stale])
    assert "stale frontend copy" not in prompt.lower()

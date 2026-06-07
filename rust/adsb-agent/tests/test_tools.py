"""Tests for tool definitions."""

from adsb_agent.tools import TOOLS, get_tool_names


def test_all_tools_have_required_fields():
    """Every tool must have type, function.name, function.description, function.parameters."""
    for tool in TOOLS:
        assert tool["type"] == "function", f"Tool missing type=function: {tool}"
        fn = tool["function"]
        assert "name" in fn, f"Tool missing name: {fn}"
        assert "description" in fn, f"Tool missing description: {fn.get('name')}"
        assert "parameters" in fn, f"Tool missing parameters: {fn['name']}"
        assert fn["parameters"]["type"] == "object", f"Parameters must be object: {fn['name']}"


def test_tool_names_are_unique():
    """No duplicate tool names."""
    names = get_tool_names()
    assert len(names) == len(set(names)), f"Duplicate tool names: {names}"


def test_get_tool_names_matches_tools():
    """get_tool_names returns names in same order as TOOLS."""
    names = get_tool_names()
    expected = [t["function"]["name"] for t in TOOLS]
    assert names == expected


def test_required_tools_present():
    """Key tools must be defined."""
    names = set(get_tool_names())
    required = {
        "getStorageStats",
        "getAircraftSummary",
        "getFlightSummary",
        "getFeedStatus",
        "getFeedMetrics",
        "startFeed",
        "stopFeed",
        "getTrajectory",
    }
    missing = required - names
    assert not missing, f"Missing required tools: {missing}"


def test_tool_parameters_have_valid_types():
    """All parameter properties must have a type field."""
    for tool in TOOLS:
        fn = tool["function"]
        props = fn["parameters"].get("properties", {})
        for prop_name, prop_def in props.items():
            assert "type" in prop_def, (
                f"Tool '{fn['name']}' param '{prop_name}' missing type"
            )


def test_mutating_tools_have_warning_descriptions():
    """Mutating tools should mention 'only call when' or similar in description."""
    mutating = {"startFeed", "stopFeed"}
    for tool in TOOLS:
        fn = tool["function"]
        if fn["name"] in mutating:
            desc = fn["description"].lower()
            assert "only call" in desc or "explicitly" in desc, (
                f"Mutating tool '{fn['name']}' should warn about explicit invocation"
            )

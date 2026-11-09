"""`setHistoryWindow`: the time depth of the history tracks layer.

Before it existed the agent could only toggle the history layer, so "show the
last 4 hours of history" got an apology. Must match `useCopilotTools.ts`.
"""

from __future__ import annotations

from adsb_agent.tools import TOOLS


def _tool(name: str) -> dict:
    for entry in TOOLS:
        if entry["function"]["name"] == name:
            return entry["function"]
    raise AssertionError(f"{name} is not declared in TOOLS")


def test_declares_depth_in_hours_as_required_number():
    params = _tool("setHistoryWindow")["parameters"]
    assert params["properties"]["depthHours"]["type"] == "number"
    assert params["required"] == ["depthHours"]


def test_window_may_end_in_the_past():
    assert _tool("setHistoryWindow")["parameters"]["properties"]["endHoursAgo"]["type"] == "number"


def test_description_names_the_history_layer_and_retention():
    description = _tool("setHistoryWindow")["description"].lower()
    assert "history" in description
    assert "retention" in description


def test_layer_visibility_points_to_it_for_depth():
    assert "setHistoryWindow" in _tool("setLayerVisibility")["description"]

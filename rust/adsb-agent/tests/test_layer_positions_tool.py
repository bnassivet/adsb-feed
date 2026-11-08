"""`setLayerVisibility.positions` vs `history`.

`positions` hides the trail of past positions behind *live* aircraft (the
desktop's "Show track positions" checkbox); `history` shows aircraft that are no
longer live. Both are "trails" in everyday speech, so the descriptions carry
the distinction the model needs. Must match `useCopilotTools.ts`.
"""

from __future__ import annotations

from adsb_agent.tools import TOOLS


def _layer_props() -> dict:
    for entry in TOOLS:
        if entry["function"]["name"] == "setLayerVisibility":
            return entry["function"]["parameters"]["properties"]
    raise AssertionError("setLayerVisibility is not declared in TOOLS")


def test_declares_positions_as_a_boolean_layer():
    assert _layer_props()["positions"]["type"] == "boolean"


def test_positions_is_about_live_aircraft_trails():
    description = _layer_props()["positions"]["description"].lower()
    assert "live aircraft" in description
    assert "icons stay visible" in description


def test_history_reads_as_aircraft_no_longer_live():
    assert "no longer live" in _layer_props()["history"]["description"].lower()


def test_declares_labels_as_a_boolean_layer():
    assert _layer_props()["labels"]["type"] == "boolean"


def test_labels_are_hex_and_callsign_beside_live_aircraft():
    description = _layer_props()["labels"]["description"].lower()
    assert "callsign" in description
    assert "live aircraft" in description


def test_declares_range_lines_as_a_boolean_layer():
    assert _layer_props()["rangeLines"]["type"] == "boolean"


def test_range_lines_run_from_the_receiver_to_selected_aircraft():
    description = _layer_props()["rangeLines"]["description"].lower()
    assert "receiver" in description
    assert "selected aircraft" in description

"""The weather tools: client-executed, and worded so the model picks the right one.

`useCopilotTools.ts` is the source of truth for the live tool surface; the
fallback list in `tools.py` and the prompt guideline must agree with it. As
with the demo-flights/generator pair, the descriptions are the interface the
model programs against, so the routing prose is asserted, not just the names.
"""

from pathlib import Path

import yaml

import adsb_agent
from adsb_agent.graph import SERVER_TOOL_NAMES
from adsb_agent.tools import TOOLS, get_tool_names

LAYER_TOOL = "setWeatherLayer"
WIND_TOOL = "getWindAloft"


def _tool(name: str) -> dict:
    return next(t["function"] for t in TOOLS if t["function"]["name"] == name)


def _guidelines() -> list[str]:
    path = Path(adsb_agent.__file__).parent / "prompt_sections.yaml"
    return yaml.safe_load(path.read_text())["guidelines"]


def test_weather_tools_are_in_the_fallback_list():
    names = set(get_tool_names())
    assert {LAYER_TOOL, WIND_TOOL} <= names


def test_weather_tools_run_in_the_frontend():
    # The snapshot lives in the desktop app; the Tauri tool server has none.
    assert LAYER_TOOL not in SERVER_TOOL_NAMES
    assert WIND_TOOL not in SERVER_TOOL_NAMES


def test_layer_tool_takes_the_level_as_text():
    props = _tool(LAYER_TOOL)["parameters"]["properties"]
    assert set(props) == {"enabled", "level", "barbs", "particles"}
    # A string, not a "surface" | number union: local models mishandle anyOf.
    assert props["level"]["type"] == "string"
    assert "FL340" in props["level"]["description"]


def test_wind_tool_is_read_only_and_reports_components():
    fn = _tool(WIND_TOOL)
    desc = fn["description"].lower()
    assert "read-only" in desc
    assert "headwind" in desc and "crosswind" in desc
    assert set(fn["parameters"]["properties"]) == {
        "hexIdent",
        "latitude",
        "longitude",
        "altitudeFt",
        "level",
    }


def test_layer_visibility_hands_weather_to_its_own_tool():
    assert LAYER_TOOL in _tool("setLayerVisibility")["description"]
    assert LAYER_TOOL in _tool(WIND_TOOL)["description"] or WIND_TOOL in _tool(LAYER_TOOL)["description"]


def test_a_guideline_routes_weather_requests():
    weather = [g for g in _guidelines() if LAYER_TOOL in g]
    assert weather, "no guideline mentions setWeatherLayer"
    assert WIND_TOOL in weather[0]
    assert "MQTT" in weather[0]

"""Keeping `toggleDemoFlights` and `generateSimulatedTrajectory` apart.

Observed with `gemma-4-12b-qat`: "start simulated flights" made the model call
`toggleDemoFlights(enabled=True)` — launching the 20 hardcoded demo routes and
generating nothing. Both tools described themselves in terms of "simulated
flights", so the model had no way to tell them apart.

The distinction the model must be able to make:

* `generateSimulatedTrajectory` — create NEW aircraft from the user's request.
* `toggleDemoFlights` — switch a fixed, built-in demo layer on or off.

These tests pin the wording that carries that distinction. They assert on prose,
which is unusual, but the prose *is* the interface the model programs against —
and it regressed silently once already.
"""

from __future__ import annotations

from adsb_agent.system_prompt import render_system_prompt
from adsb_agent.tools import TOOLS

SIM_TOOL = "generateSimulatedTrajectory"
DEMO_TOOL = "toggleDemoFlights"
LAYER_TOOL = "setLayerVisibility"


def _tool(name: str) -> dict:
    for entry in TOOLS:
        if entry["function"]["name"] == name:
            return entry["function"]
    raise AssertionError(f"{name} is not declared in TOOLS")


class TestDemoFlightsToolIsUnambiguous:
    def test_names_the_built_in_layer(self):
        """"Demo flights" must read as a fixed layer, not as "make me aircraft"."""
        description = _tool(DEMO_TOOL)["description"].lower()
        assert "built-in" in description or "pre-defined" in description

    def test_redirects_generation_requests(self):
        """The model needs the alternative named at the point of confusion."""
        assert SIM_TOOL in _tool(DEMO_TOOL)["description"]

    def test_says_it_creates_nothing(self):
        description = _tool(DEMO_TOOL)["description"].lower()
        assert "does not create" in description or "creates no" in description


class TestGenerationToolClaimsThePhrasing:
    def test_covers_the_verbs_users_actually_use(self):
        """'start'/'run'/'create ... simulated flights' must land here."""
        description = _tool(SIM_TOOL)["description"].lower()
        for verb in ("start", "run", "create"):
            assert verb in description, f"{verb!r} missing from {SIM_TOOL} description"

    def test_still_describes_generation(self):
        assert "generate" in _tool(SIM_TOOL)["description"].lower()


class TestCategoryIsOptional:
    """A bare "start simulated flights" should fly something, not ask a question.

    With `category` required the model stopped to ask "what type of aircraft?",
    costing a round-trip for a request that has an obvious default.
    """

    def test_no_required_parameters(self):
        assert _tool(SIM_TOOL)["parameters"].get("required", []) == []

    def test_default_is_documented_for_the_model(self):
        description = _tool(SIM_TOOL)["parameters"]["properties"]["category"]["description"]
        assert "ga" in description.lower()
        assert "default" in description.lower()

    def test_payload_survives_an_omitted_category(self):
        """Declaring it optional is only safe if the wire path tolerates absence.

        The simulation agent falls back to GA for a missing or unknown category,
        so the field simply should not be sent.
        """
        from adsb_agent.a2a_client import build_trajectory_payload

        payload = build_trajectory_payload({"count": 3, "routeHint": "over the city"})
        assert "category" not in payload
        assert payload["count"] == 3

    def test_guideline_tells_the_model_not_to_ask(self):
        prompt = render_system_prompt(None, None).lower()
        assert "don't ask which aircraft type" in prompt or "do not ask which" in prompt


class TestLayerVisibilityIsScoped:
    def test_simulation_layer_mentions_the_demo_flights(self):
        """`setLayerVisibility(simulation=True)` shows the same 20 demo routes."""
        param = _tool(LAYER_TOOL)["parameters"]["properties"]["simulation"]
        assert "demo" in param["description"].lower()


class TestSystemPromptDrawsTheLine:
    def test_a_guideline_contrasts_the_two_tools(self):
        prompt = render_system_prompt(None, None)
        guideline = next(
            (line for line in prompt.splitlines() if SIM_TOOL in line and DEMO_TOOL in line),
            None,
        )
        assert guideline is not None, "no guideline mentions both tools together"

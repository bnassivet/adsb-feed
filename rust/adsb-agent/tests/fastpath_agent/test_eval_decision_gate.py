"""The decision-model gate built from the tool descriptions.

One request carries several independent ``choice`` questions: the kind of
message, the family of display commands, and one tool choice per family whose
options are the tools' full descriptions. The code under test builds those
questions and walks the answers.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "eval"))

from fastpath_agent.decision_gate import (  # noqa: E402
    COMMAND,
    FAMILIES,
    build_questions,
    signals,
    state_text,
)
from fastpath_agent.eval_route import DIRECT_TOOLS  # noqa: E402

DESCRIPTIONS = {name: f"description of {name}" for name in DIRECT_TOOLS}


class TestFamilies:
    def test_every_direct_tool_is_in_exactly_one_family(self):
        names = [name for tools, _ in FAMILIES.values() for name in tools]
        assert sorted(names) == sorted(DIRECT_TOOLS)

    def test_a_family_is_small_enough_for_one_question(self):
        """Fifteen full descriptions overflow the model's 512-token question."""
        assert all(len(tools) <= 4 for tools, _ in FAMILIES.values())


class TestBuildQuestions:
    def test_every_question_is_a_choice(self):
        questions = build_questions(DESCRIPTIONS)
        assert {q["type"] for q in questions.values()} == {"choice"}
        assert set(questions) == {"kind", "route", *(f"tool:{f}" for f in FAMILIES)}

    def test_tool_choices_carry_the_full_descriptions_and_no_catch_all(self):
        """A "none of these" option competes with the real ones; ``kind`` says
        whether any command applies instead."""
        options = build_questions(DESCRIPTIONS)["tool:view"]["criteria"]
        assert options == {name: DESCRIPTIONS[name] for name in FAMILIES["view"][0]}

    def test_route_offers_every_family_beside_the_non_commands(self):
        options = build_questions(DESCRIPTIONS)["route"]["criteria"]
        assert set(FAMILIES) < set(options)
        assert {"question", "simulation", "other"} < set(options)

    def test_a_tool_missing_from_the_families_is_an_error(self):
        with pytest.raises(ValueError, match="newTool"):
            build_questions({**DESCRIPTIONS, "newTool": "x"})


class TestStateText:
    def test_a_first_request_is_sent_as_is(self):
        assert state_text("hide the labels", []) == "hide the labels"

    def test_earlier_requests_are_labelled(self):
        assert state_text("and now?", ["show history"]) == (
            "Earlier message: show history\nLatest message: and now?"
        )


def answers(command: float, route: dict[str, float], tools: dict[str, dict[str, float]]):
    rest = (1 - command) / 3
    full_route = {f: 0.0 for f in FAMILIES} | {"question": 0.0, "simulation": 0.0, "other": 0.0}
    out = {
        "kind": {COMMAND: command, "question": rest, "simulation": rest, "other": rest},
        "route": full_route | route,
    }
    for family, (names, _) in FAMILIES.items():
        out[f"tool:{family}"] = tools.get(family) or {n: 1 / len(names) for n in names}
    return out


class TestSignals:
    def test_the_tool_is_read_from_the_family_the_route_names(self):
        s = signals(
            answers(
                0.9,
                {"view": 0.8, "layers": 0.1, "question": 0.1},
                {
                    "view": {
                        "setMapTheme": 0.7,
                        "toggleSidebar": 0.1,
                        "setActiveMode": 0.1,
                        "panMapTo": 0.1,
                    },
                    "layers": {
                        "setLayerVisibility": 0.98,
                        "toggleDemoFlights": 0.01,
                        "setWeatherLayer": 0.01,
                    },
                },
            )
        )
        assert (s["family"], s["tool"]) == ("view", "setMapTheme")
        assert s["command_family_tool"] == pytest.approx(0.9 * 0.8 * 0.7)
        assert s["vetoed"] is False

    def test_the_family_is_the_best_family_even_when_a_non_command_scores_higher(self):
        """The choice always names a family; ``command`` carries the doubt."""
        s = signals(answers(0.1, {"question": 0.9, "aircraft_feed": 0.1}, {}))
        assert s["family"] == "aircraft_feed"
        assert s["vetoed"] is True

    @pytest.mark.parametrize(("command", "vetoed"), [(0.49, True), (0.5, False)])
    def test_veto_below_one_half(self, command, vetoed):
        assert signals(answers(command, {"view": 1.0}, {}))["vetoed"] is vetoed

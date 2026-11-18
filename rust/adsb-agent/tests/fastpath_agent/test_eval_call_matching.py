"""Matching a model's tool calls against the expected calls of a direct command.

The executor evaluation used to accept any call whose arguments fit the tool's
schema. ``setMapTheme(theme="light")`` fits the schema and is still the wrong
answer to "switch to night mode", so the labels now carry expected values and
this matcher decides whether a reply carries the command out.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "eval"))

from fastpath_agent.call_matching import calls_match  # noqa: E402


def call(name, **args):
    return {"name": name, "args": args}


def expect(tool, args=None, optional=None, required=True):
    out = {"tool": tool, "args": args or {}}
    if optional:
        out["optional"] = optional
    if not required:
        out["required"] = False
    return out


NIGHT = [[expect("setMapTheme", {"theme": "dark"})]]


class TestValues:
    def test_exact_match(self):
        assert calls_match([call("setMapTheme", theme="dark")], NIGHT)

    def test_wrong_value(self):
        assert not calls_match([call("setMapTheme", theme="light")], NIGHT)

    def test_wrong_tool(self):
        assert not calls_match([call("toggleSidebar", open=False)], NIGHT)

    def test_missing_argument(self):
        assert not calls_match([call("setMapTheme")], NIGHT)

    def test_strings_ignore_case_and_spaces(self):
        expected = [[expect("selectAircraft", {"hexIdent": "4CA7B2"})]]
        assert calls_match([call("selectAircraft", hexIdent=" 4ca7b2 ")], expected)

    def test_numbers_compare_by_value(self):
        expected = [[expect("setHistoryWindow", {"depthHours": 4})]]
        assert calls_match([call("setHistoryWindow", depthHours=4.0)], expected)
        assert not calls_match([call("setHistoryWindow", depthHours=5)], expected)

    def test_a_boolean_is_not_a_number(self):
        """True == 1 in Python; a model sending 1 for a flag has not sent true."""
        expected = [[expect("toggleSidebar", {"open": True})]]
        assert not calls_match([call("toggleSidebar", open=1)], expected)

    def test_a_string_is_not_a_boolean(self):
        expected = [[expect("toggleSidebar", {"open": False})]]
        assert not calls_match([call("toggleSidebar", open="false")], expected)


class TestExtraArguments:
    EXPECTED = [[expect("setHistoryWindow", {"depthHours": 4}, {"endHoursAgo": [0]})]]

    def test_unlisted_extra_argument_fails(self):
        """An extra layer switched on is a wrong action, not a harmless one."""
        expected = [[expect("setLayerVisibility", {"labels": False})]]
        assert not calls_match([call("setLayerVisibility", labels=False, density=True)], expected)

    def test_optional_argument_may_be_absent(self):
        assert calls_match([call("setHistoryWindow", depthHours=4)], self.EXPECTED)

    def test_optional_argument_with_an_allowed_value(self):
        assert calls_match([call("setHistoryWindow", depthHours=4, endHoursAgo=0)], self.EXPECTED)

    def test_optional_argument_with_another_value_fails(self):
        assert not calls_match(
            [call("setHistoryWindow", depthHours=4, endHoursAgo=2)], self.EXPECTED
        )

    def test_wildcard_optional_accepts_anything(self):
        expected = [[expect("panMapTo", {"latitude": 47.2, "longitude": -1.55}, {"zoom": "*"})]]
        assert calls_match([call("panMapTo", latitude=47.2, longitude=-1.55, zoom=9)], expected)


class TestSeveralCalls:
    BOTH = [[expect("setMapTheme", {"theme": "dark"}), expect("toggleSidebar", {"open": False})]]

    def test_all_required_calls_in_any_order(self):
        calls = [call("toggleSidebar", open=False), call("setMapTheme", theme="dark")]
        assert calls_match(calls, self.BOTH)

    def test_a_missing_call_fails(self):
        assert not calls_match([call("setMapTheme", theme="dark")], self.BOTH)

    def test_an_unexpected_extra_call_fails(self):
        assert not calls_match([call("setMapTheme", theme="dark"), call("startFeed")], NIGHT)

    def test_a_non_required_call_may_be_present_or_absent(self):
        expected = [
            [
                expect("setDensityConfig", {"altitudeMax": 10000}),
                expect("setLayerVisibility", {"density": True}, required=False),
            ]
        ]
        assert calls_match([call("setDensityConfig", altitudeMax=10000)], expected)
        assert calls_match(
            [call("setDensityConfig", altitudeMax=10000), call("setLayerVisibility", density=True)],
            expected,
        )

    def test_a_non_required_call_must_still_be_right(self):
        expected = [
            [
                expect("setDensityConfig", {"altitudeMax": 10000}),
                expect("setLayerVisibility", {"density": True}, required=False),
            ]
        ]
        assert not calls_match(
            [
                call("setDensityConfig", altitudeMax=10000),
                call("setLayerVisibility", density=False),
            ],
            expected,
        )


class TestAlternatives:
    DEMO_ON = [
        [expect("toggleDemoFlights", {"enabled": True})],
        [expect("setLayerVisibility", {"simulation": True})],
    ]

    def test_either_alternative_is_accepted(self):
        assert calls_match([call("toggleDemoFlights", enabled=True)], self.DEMO_ON)
        assert calls_match([call("setLayerVisibility", simulation=True)], self.DEMO_ON)

    def test_none_matching_fails(self):
        assert not calls_match([call("toggleDemoFlights", enabled=False)], self.DEMO_ON)

    def test_no_calls_never_match(self):
        assert not calls_match([], self.DEMO_ON)


def test_accepts_arrays_as_returned_by_the_dataset():
    """MLflow hands nested expectations back as numpy arrays, not lists."""
    import numpy as np

    expected = np.array(
        [np.array([expect("setMapTheme", {"theme": "dark"})], dtype=object)], dtype=object
    )
    assert calls_match([call("setMapTheme", theme="dark")], expected)

"""`POST /scenario/describe` — the scenario panel's non-chat entry point.

The "Generate from trajectories" button lives in the desktop app's left panel,
outside the chat tree, and must work with the chat closed. Same reasoning as
`/simulate/trajectory`: a button press shouldn't have to fake a chat turn.

Unlike the chat path this is a single-shot LLM call with no graph and no tools,
so the tests inject a fake model through `describe_scenario`'s `model=` seam —
the same seam `build_agent_graph` uses.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from adsb_agent import describe as d
from adsb_agent import main as m
from adsb_agent.models import DescribeScenarioRequest, TrackDigest

TRACKS = [
    {
        "callsign": "HELI01",
        "category": "helicopter",
        "start_offset_s": 0,
        "waypoint_count": 40,
        "duration_s": 300,
        "phases": ["climb", "cruise"],
        "alt_ft_min": 0,
        "alt_ft_max": 2500,
        "speed_kts_min": 0,
        "speed_kts_max": 110,
        "start_lat": 45.5,
        "start_lng": -73.6,
        "end_lat": 45.7,
        "end_lng": -73.4,
    },
    {
        "callsign": "ACA825",
        "category": "airliner",
        "start_offset_s": 90,
        "waypoint_count": 120,
        "duration_s": 600,
        "phases": ["cruise", "descent"],
        "alt_ft_min": 3000,
        "alt_ft_max": 31000,
        "speed_kts_min": 180,
        "speed_kts_max": 450,
        "start_lat": 46.0,
        "start_lng": -74.0,
        "end_lat": 45.5,
        "end_lng": -73.6,
    },
]


def make_request(**overrides) -> DescribeScenarioRequest:
    payload = {"name": "Approach Rush", "tracks": TRACKS}
    payload.update(overrides)
    return DescribeScenarioRequest.model_validate(payload)


class FakeModel:
    """Stands in for ChatOpenAI: records the prompt, returns canned content."""

    def __init__(self, content="Two aircraft converge on the field.", error=None):
        self.content = content
        self.error = error
        self.prompt = None

    async def ainvoke(self, messages):
        self.prompt = messages
        if self.error is not None:
            raise self.error

        class _Msg:
            content = self.content

        return _Msg()


@pytest.fixture
async def client():
    async with AsyncClient(
        transport=ASGITransport(app=m.app), base_url="http://test"
    ) as c:
        yield c


# ---------------------------------------------------------------------------
# Prompt building — pure, no LLM
# ---------------------------------------------------------------------------


class TestBuildDescribePrompt:
    def test_includes_the_scenario_name(self):
        prompt = d.build_describe_prompt(make_request())
        assert "Approach Rush" in prompt

    def test_includes_every_callsign_and_category(self):
        prompt = d.build_describe_prompt(make_request())
        for expected in ("HELI01", "helicopter", "ACA825", "airliner"):
            assert expected in prompt

    def test_states_the_relative_timing(self):
        """Offsets are the whole point of a scenario — the model must see them."""
        prompt = d.build_describe_prompt(make_request())
        assert "90" in prompt

    def test_asks_for_plain_prose_without_markdown(self):
        """Format rules belong in the system prompt, not repeated per request."""
        lowered = d.SYSTEM_PROMPT.lower()
        assert "markdown" in lowered
        assert "sentence" in lowered
        assert "preamble" in lowered

    def test_caps_the_description_at_four_sentences(self):
        assert "4 sentences" in d.SYSTEM_PROMPT

    def test_forbids_rattling_off_kinematic_detail(self):
        """A description should say what happens, not recite the flight data."""
        lowered = d.SYSTEM_PROMPT.lower()
        assert "altitude" in lowered
        assert "coordinate" in lowered
        assert "do not" in lowered

    def test_handles_a_scenario_with_no_tracks(self):
        """Guarded in the UI, but the prompt builder must not crash on it."""
        prompt = d.build_describe_prompt(make_request(tracks=[]))
        assert "Approach Rush" in prompt

    def test_omits_position_detail_for_a_track_with_no_route(self):
        empty = dict(TRACKS[0], waypoint_count=0, phases=[], start_lat=None, end_lat=None)
        prompt = d.build_describe_prompt(make_request(tracks=[empty]))
        assert "HELI01" in prompt
        assert "None" not in prompt, "null fields must not leak into the prompt as 'None'"


class TestRouteDescription:
    """The route hint the aircraft was generated from beats derived kinematics.

    "orbit the port then land downtown" tells the model what the aircraft is
    *doing*; "altitude 0 to 2500 ft, speed 0 to 110 kts" only tells it what a
    helicopter is. When we have the former, the latter is noise.
    """

    def test_uses_the_route_description_when_present(self):
        routed = dict(TRACKS[0], route="orbit the port then land downtown")
        prompt = d.build_describe_prompt(make_request(tracks=[routed]))
        assert "orbit the port then land downtown" in prompt

    def test_drops_the_kinematic_detail_when_a_route_is_known(self):
        routed = dict(TRACKS[0], route="orbit the port then land downtown")
        prompt = d.build_describe_prompt(make_request(tracks=[routed]))

        assert "2500" not in prompt, "altitude envelope is redundant beside a route"
        assert "110" not in prompt, "speed envelope is redundant beside a route"
        assert "45.5" not in prompt, "coordinates are redundant beside a route"

    def test_keeps_the_identity_and_timing_alongside_a_route(self):
        """Offsets are the point of a scenario and are never derivable."""
        routed = dict(TRACKS[1], route="approach from the north")
        prompt = d.build_describe_prompt(make_request(tracks=[routed]))

        assert "ACA825" in prompt
        assert "airliner" in prompt
        assert "90" in prompt

    def test_falls_back_to_kinematics_without_a_route(self):
        prompt = d.build_describe_prompt(make_request(tracks=[TRACKS[0]]))
        assert "2500" in prompt

    def test_treats_a_blank_route_as_absent(self):
        blank = dict(TRACKS[0], route="   ")
        prompt = d.build_describe_prompt(make_request(tracks=[blank]))
        assert "2500" in prompt, "a whitespace-only hint must not suppress the fallback"

    def test_mixes_routed_and_unrouted_tracks(self):
        routed = dict(TRACKS[0], route="orbit the port")
        prompt = d.build_describe_prompt(make_request(tracks=[routed, TRACKS[1]]))

        assert "orbit the port" in prompt
        assert "31000" in prompt, "the unrouted track still describes itself"


# ---------------------------------------------------------------------------
# describe_scenario
# ---------------------------------------------------------------------------


class TestDescribeScenario:
    async def test_returns_the_model_output(self):
        model = FakeModel(content="A helicopter departs as an airliner descends.")
        result = await d.describe_scenario(make_request(), model=model)
        assert result == "A helicopter departs as an airliner descends."

    async def test_passes_the_built_prompt_to_the_model(self):
        model = FakeModel()
        await d.describe_scenario(make_request(), model=model)
        assert model.prompt is not None
        assert "Approach Rush" in str(model.prompt)

    async def test_strips_a_conversational_preamble(self):
        """Small local models love to open with 'Here is the description:'."""
        model = FakeModel(content="Here is the description:\n\nTwo aircraft converge.")
        result = await d.describe_scenario(make_request(), model=model)
        assert result == "Two aircraft converge."

    async def test_strips_surrounding_quotes(self):
        model = FakeModel(content='"Two aircraft converge."')
        result = await d.describe_scenario(make_request(), model=model)
        assert result == "Two aircraft converge."

    async def test_strips_whitespace(self):
        model = FakeModel(content="\n  Two aircraft converge.\n")
        result = await d.describe_scenario(make_request(), model=model)
        assert result == "Two aircraft converge."

    async def test_raises_when_the_model_returns_nothing(self):
        """A reasoning-variant model can emit only reasoning and no content."""
        model = FakeModel(content="")
        with pytest.raises(ValueError, match="empty"):
            await d.describe_scenario(make_request(), model=model)


# ---------------------------------------------------------------------------
# The endpoint
# ---------------------------------------------------------------------------


class TestEndpoint:
    async def test_returns_the_description(self, client, monkeypatch):
        async def fake(request, *, model=None):
            return "Two aircraft converge on the field."

        monkeypatch.setattr(m, "describe_scenario", fake)

        response = await client.post(
            "/scenario/describe", json={"name": "Approach Rush", "tracks": TRACKS}
        )
        assert response.status_code == 200
        assert response.json()["description"] == "Two aircraft converge on the field."

    async def test_forwards_the_parsed_request(self, client, monkeypatch):
        seen = {}

        async def fake(request, *, model=None):
            seen["name"] = request.name
            seen["tracks"] = len(request.tracks)
            return "ok"

        monkeypatch.setattr(m, "describe_scenario", fake)
        await client.post("/scenario/describe", json={"name": "Rush", "tracks": TRACKS})

        assert seen == {"name": "Rush", "tracks": 2}

    async def test_502_when_the_llm_is_unreachable(self, client, monkeypatch):
        """The LLM endpoint being down is an upstream failure, not a bad request."""

        async def fake(request, *, model=None):
            raise ConnectionError("connection refused")

        monkeypatch.setattr(m, "describe_scenario", fake)

        response = await client.post(
            "/scenario/describe", json={"name": "Rush", "tracks": TRACKS}
        )
        assert response.status_code == 502
        assert "connection refused" in response.json()["detail"]

    async def test_502_when_the_model_returns_nothing(self, client, monkeypatch):
        async def fake(request, *, model=None):
            raise ValueError("model returned an empty description")

        monkeypatch.setattr(m, "describe_scenario", fake)

        response = await client.post(
            "/scenario/describe", json={"name": "Rush", "tracks": TRACKS}
        )
        assert response.status_code == 502

    async def test_422_on_a_missing_name(self, client):
        response = await client.post("/scenario/describe", json={"tracks": TRACKS})
        assert response.status_code == 422

    async def test_accepts_an_empty_track_list(self, client, monkeypatch):
        async def fake(request, *, model=None):
            return "An empty scenario."

        monkeypatch.setattr(m, "describe_scenario", fake)

        response = await client.post(
            "/scenario/describe", json={"name": "Empty", "tracks": []}
        )
        assert response.status_code == 200


class TestTrackDigestModel:
    def test_accepts_nulls_for_a_routeless_track(self):
        digest = TrackDigest.model_validate(
            {
                "callsign": "X",
                "category": "ga",
                "start_offset_s": 0,
                "waypoint_count": 0,
                "duration_s": 0,
                "phases": [],
                "alt_ft_min": None,
                "alt_ft_max": None,
                "speed_kts_min": None,
                "speed_kts_max": None,
                "start_lat": None,
                "start_lng": None,
                "end_lat": None,
                "end_lng": None,
            }
        )
        assert digest.callsign == "X"
        assert digest.alt_ft_min is None

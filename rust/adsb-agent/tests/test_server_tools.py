"""Backend tools are owned by the agent, not supplied by the frontend.

AG-UI: "`RunAgentInput.tools` is only for these client-provided tools. It is
not intended to contain every tool available to the backend agent... advertise
them through agent capabilities instead of sending their schemas from the
client." (docs.ag-ui.com/concepts/tools)

Before this, a server tool was callable only if the desktop happened to send
its schema -- which silently disabled `getTimeDistribution` and
`getHourlyHeatmap`, never declared by any frontend.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from ag_ui.core import Tool

from adsb_agent import graph as g
from adsb_agent.server_tools import SERVER_TOOL_NAMES, SERVER_TOOLS, effective_tools


def _client(name: str, description: str = "client copy"):
    return Tool(name=name, description=description, parameters={"type": "object", "properties": {}})


class TestServerToolDefinitions:
    def test_names_are_derived_from_the_definitions(self):
        assert SERVER_TOOL_NAMES == frozenset(t.name for t in SERVER_TOOLS)

    def test_names_are_unique(self):
        names = [t.name for t in SERVER_TOOLS]
        assert len(names) == len(set(names))

    def test_covers_the_data_plane_and_the_simulation_proxy(self):
        assert SERVER_TOOL_NAMES == {
            "getStorageStats",
            "getAircraftSummary",
            "getFlightSummary",
            "getTrajectory",
            "getTimeDistribution",
            "getHourlyHeatmap",
            "getEventsOfInterest",
            "getCurrentDateTime",
            "generateSimulatedTrajectory",
        }

    @pytest.mark.parametrize("tool", SERVER_TOOLS, ids=lambda t: t.name)
    def test_every_schema_is_an_object_schema_with_typed_properties(self, tool):
        assert tool.description
        assert tool.parameters["type"] == "object"
        for prop, spec in tool.parameters.get("properties", {}).items():
            assert "type" in spec, f"{tool.name}.{prop} has no type"
        for req in tool.parameters.get("required", []):
            assert req in tool.parameters["properties"], f"{tool.name} requires unknown {req}"

    def test_graph_reexports_the_same_names(self):
        assert g.SERVER_TOOL_NAMES == SERVER_TOOL_NAMES


class TestSchemasMatchTheRustQueryTypes:
    """`adsb-data-server` deserialises these with serde; a missing required
    field is "Invalid arguments: missing field", not a default."""

    def _required(self, name: str) -> set[str]:
        tool = next(t for t in SERVER_TOOLS if t.name == name)
        return set(tool.parameters.get("required", []))

    def test_time_distribution_requires_range_and_bucket_count(self):
        # TimeDistributionQuery { start_ms: i64, end_ms: i64, num_buckets: u32, metric (default) }
        assert self._required("getTimeDistribution") == {"startMs", "endMs", "numBuckets"}

    def test_hourly_heatmap_requires_range(self):
        # HourlyHeatmapQuery { start_ms: i64, end_ms: i64 }
        assert self._required("getHourlyHeatmap") == {"startMs", "endMs"}

    def test_trajectory_requires_hex_ident(self):
        # TrajectoryQuery { hex_ident: String, start_ms: Option, end_ms: Option }
        assert self._required("getTrajectory") == {"hexIdent"}

    def test_time_distribution_metric_values_map_to_the_rust_enum(self):
        tool = next(t for t in SERVER_TOOLS if t.name == "getTimeDistribution")
        values = tool.parameters["properties"]["metric"]["enum"]
        # transform_server_args snake_cases these; the Rust enum is rename_all = "snake_case".
        assert {g.transform_server_args({"metric": v})["metric"] for v in values} == {
            "positions",
            "aircraft",
            "raw_messages",
            "flights",
        }

    def test_no_description_promises_the_frontend_only_truncation_envelope(self):
        """`{ total, showing, data, note }` came from the deleted frontend
        handlers; the server path returns plain arrays."""
        for tool in SERVER_TOOLS:
            assert "showing" not in tool.description, tool.name


class TestEffectiveTools:
    def test_no_client_tools_yields_the_full_server_surface(self):
        assert [t.name for t in effective_tools(None)] == [t.name for t in SERVER_TOOLS]
        assert [t.name for t in effective_tools([])] == [t.name for t in SERVER_TOOLS]

    def test_client_tools_are_appended(self):
        names = [t.name for t in effective_tools([_client("panMapTo")])]
        assert names[: len(SERVER_TOOLS)] == [t.name for t in SERVER_TOOLS]
        assert names[-1] == "panMapTo"

    def test_server_definition_wins_over_a_client_copy(self):
        """An older desktop still sends `getStorageStats`; it must not
        duplicate the tool or replace the agent's schema."""
        merged = effective_tools([_client("getStorageStats", "stale frontend copy")])
        matches = [t for t in merged if t.name == "getStorageStats"]
        assert len(matches) == 1
        assert matches[0].description != "stale frontend copy"

    def test_accepts_duck_typed_tools(self):
        """Tests and the LangGraph Studio path pass SimpleNamespace objects."""
        ns = SimpleNamespace(name="selectAircraft", description="d", parameters={})
        assert effective_tools([ns])[-1] is ns


class TestPartition:
    def test_server_tools_are_available_when_the_client_sent_none_of_them(self):
        server, client = g.partition_tool_names([_client("panMapTo")])
        assert server == set(SERVER_TOOL_NAMES)
        assert client == {"panMapTo"}

    def test_a_client_copy_of_a_server_tool_stays_server_side(self):
        server, client = g.partition_tool_names([_client("getTrajectory"), _client("panMapTo")])
        assert "getTrajectory" in server
        assert client == {"panMapTo"}


class _FakeModel:
    """Returns queued AIMessages in order (same stub as test_tool_spans)."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0

    async def ainvoke(self, _messages):
        resp = self._responses[self.calls]
        self.calls += 1
        return resp


class TestGraphExecutesServerToolsTheClientNeverSent:
    async def test_server_call_runs_in_loop_with_only_client_tools_supplied(self, monkeypatch):
        """The old intersection routed this to END and forwarded
        `getStorageStats` to a browser that no longer declares it."""
        from langchain_core.messages import AIMessage, HumanMessage

        executed: list[str] = []

        async def fake_exec(name, args, client):
            executed.append(name)
            return '{"row_count": 1}'

        monkeypatch.setattr(g, "execute_server_tool", fake_exec)

        model = _FakeModel(
            [
                AIMessage(content="", tool_calls=[{"name": "getStorageStats", "args": {}, "id": "t1"}]),
                AIMessage(content="one row"),
            ]
        )
        graph = g.build_agent_graph([_client("panMapTo")], model=model)
        result = await graph.ainvoke({"messages": [HumanMessage(content="how many?")]})

        assert executed == ["getStorageStats"]
        assert result["messages"][-1].content == "one row"


class TestCountQuestionWording:
    """Ported from useCopilotTools.test.ts when these tools moved here.

    The model must route "how many ... in [time range]" to the historical tools
    and "how many right now" to the client tool `searchLiveFlights`.
    """

    def _desc(self, name: str) -> str:
        return next(t for t in SERVER_TOOLS if t.name == name).description

    @pytest.mark.parametrize("name", ["getFlightSummary", "getAircraftSummary", "getStorageStats"])
    def test_historical_tools_say_so(self, name):
        assert "Historical" in self._desc(name)

    @pytest.mark.parametrize("name", ["getFlightSummary", "getAircraftSummary"])
    def test_summaries_say_how_to_count(self, name):
        assert "how many" in self._desc(name).lower()

    def test_storage_stats_points_in_total_questions_at_flight_count(self):
        assert "flight_count" in self._desc("getStorageStats")

    def test_storage_stats_redirects_live_questions(self):
        assert "searchLiveFlights" in self._desc("getStorageStats")

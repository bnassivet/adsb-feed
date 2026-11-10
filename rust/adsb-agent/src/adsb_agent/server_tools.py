"""Backend tools: owned, declared and executed by this agent.

AG-UI separates two kinds of tool (docs.ag-ui.com/concepts/tools):

* **Client tools** travel in ``RunAgentInput.tools`` on every run. The frontend
  executes them, and it may add or remove them at any time.
* **Backend tools** belong to the agent. "``RunAgentInput.tools`` is only for
  these client-provided tools. It is not intended to contain every tool
  available to the backend agent... advertise them through agent capabilities
  instead of sending their schemas from the client."

These are the backend tools. ``graph.py`` executes them inside the reasoning
loop. Most are proxied to the Tauri / ``adsb-data-server`` tool server, the
clock is resolved locally, and the simulation tool goes over A2A. ``/info``
advertises them as ``capabilities.tools.items``.

They used to be declared by the desktop instead, and a server tool was callable
only if the frontend had sent its schema. That silently disabled
``getTimeDistribution`` and ``getHourlyHeatmap``, which no frontend declared.
Never register these names as frontend tools again; the desktop has a test that
pins this.

**Schemas must match the Rust query types** in ``adsb-data-engine/src/types.rs``.
``transform_server_args`` snake-cases the keys, and serde rejects a missing
non-``Option`` field with "Invalid arguments: missing field" rather than filling
in a default.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from ag_ui.core import Tool

_START_MS = {"type": "integer", "description": "Start time in milliseconds since Unix epoch"}
_END_MS = {"type": "integer", "description": "End time in milliseconds since Unix epoch"}


def _tool(name: str, description: str, properties: dict | None = None, required: list[str] | None = None) -> Tool:
    return Tool(
        name=name,
        description=description,
        parameters={
            "type": "object",
            "properties": properties or {},
            "required": required or [],
        },
    )


SERVER_TOOLS: list[Tool] = [
    _tool(
        "getStorageStats",
        "Historical: a database overview. Returns counts and metadata for the persistent store: "
        "row_count (position records), flight_count (segmented flights ever recorded), "
        "event_count (events of interest), file size, and date range. Use flight_count to "
        "answer 'how many flights in the database / in total'. It does not reflect the "
        "aircraft active right now; use searchLiveFlights for that.",
    ),
    _tool(
        "getAircraftSummary",
        "Historical: queries the database. Summary of the unique aircraft (by hex_ident) seen "
        "in a time range. Returns an array of hex_ident, callsign, position count, "
        "altitude/speed ranges and first/last seen timestamps. Use the array length to "
        "answer 'how many distinct aircraft did we see in [time range]'.",
        {"startMs": _START_MS, "endMs": _END_MS},
    ),
    _tool(
        "getFlightSummary",
        "Historical: queries the database. Summary of the flights in a time range, "
        "segmented automatically wherever coverage has a gap of more than one hour. Returns an "
        "array of flights; use its length to answer 'how many flights were there in [time "
        "range]'. Provide startMs/endMs to bound the query; without them it can be expensive.",
        {"startMs": _START_MS, "endMs": _END_MS},
    ),
    _tool(
        "getTrajectory",
        "Historical: the position history (trajectory) of one aircraft. Returns a list of "
        "lat/lon/altitude/speed/timestamp records.",
        {
            "hexIdent": {"type": "string", "description": "Aircraft hex identifier (ICAO)"},
            "startMs": _START_MS,
            "endMs": _END_MS,
        },
        ["hexIdent"],
    ),
    _tool(
        "getTimeDistribution",
        "Historical: a histogram of activity over a time range, split into numBuckets equal "
        "buckets. Counts positions, distinct aircraft, raw messages or flights per bucket. "
        "Use it for 'when was it busiest' or 'activity over the last N hours'.",
        {
            "startMs": _START_MS,
            "endMs": _END_MS,
            "numBuckets": {
                "type": "integer",
                "description": "How many equal-width buckets to split the range into, e.g. 24 for hourly over a day",
            },
            "metric": {
                "type": "string",
                "enum": ["Positions", "Aircraft", "RawMessages", "Flights"],
                "description": "What to count per bucket (default Positions)",
            },
        },
        ["startMs", "endMs", "numBuckets"],
    ),
    _tool(
        "getHourlyHeatmap",
        "Historical: aircraft and message counts on a day x hour-of-day grid (UTC) for a "
        "time range. Use it to find peak activity patterns.",
        {"startMs": _START_MS, "endMs": _END_MS},
        ["startMs", "endMs"],
    ),
    _tool(
        "getEventsOfInterest",
        "Search the events of interest stored in the database. Filter by time range and/or "
        "category. Returns event title, description, location, category, linked aircraft and "
        "timestamps.",
        {
            "startMs": _START_MS,
            "endMs": _END_MS,
            "category": {"type": "string", "description": "Filter by event category"},
        },
    ),
    _tool(
        "getCurrentDateTime",
        "Get the current date, time, timezone and epoch milliseconds. Use it to resolve "
        "relative time references (e.g. 'last hour', 'today') into absolute timestamps for "
        "other tools.",
    ),
    _tool(
        "generateSimulatedTrajectory",
        "Generate new simulated aircraft with realistic flight paths and "
        "show them flying on the map. This is THE tool for any request to "
        "start, run, create, add, simulate or fake flights or aircraft — "
        "e.g. 'start simulated flights', 'run three simulated flights', "
        "'simulate a helicopter circling downtown', 'show me a fighter "
        "doing aerobatics'. Do not use toggleDemoFlights for these. "
        "The aircraft appear on the map automatically; "
        "just confirm what you generated. These are simulated, not real "
        "traffic — never mix them into answers about observed aircraft.",
        {
            "category": {
                "type": "string",
                "enum": ["airliner", "ga", "helicopter", "fighter"],
                "description": (
                    "Aircraft performance class to simulate. Optional — "
                    "defaults to 'ga'. Infer it from the request when the "
                    "user names an aircraft type; otherwise omit it rather "
                    "than asking them which type they want."
                ),
            },
            "count": {
                "type": "integer",
                "description": "How many aircraft to generate (default 1, max 20)",
            },
            "routeHint": {
                "type": "string",
                "description": (
                    "The user's own words describing the desired route, passed "
                    "verbatim. Copy the WHOLE route description, including every "
                    "leg of a multi-leg request ('come from here, circle there, "
                    "then head over there') and every latitude/longitude the "
                    "user wrote, exactly as they wrote them. Do not summarise "
                    "it, do not drop the coordinates, and do not invent "
                    "coordinates, headings or distances of your own. The "
                    "simulation agent interprets the whole thing."
                ),
            },
            "originLat": {
                "type": "number",
                "description": "Receiver latitude; the routes are built around this point",
            },
            "originLng": {
                "type": "number",
                "description": "Receiver longitude; the routes are built around this point",
            },
            "cruiseAltitudeFt": {
                "type": "integer",
                "description": "Optional target altitude in feet",
            },
        },
        # Nothing is required: every field has a sensible default, so a bare
        # "start simulated flights" generates aircraft instead of stalling to
        # ask which type the user wants.
    ),
]

SERVER_TOOL_NAMES: frozenset[str] = frozenset(t.name for t in SERVER_TOOLS)


def effective_tools(client_tools: Iterable[Any] | None) -> list[Any]:
    """The tool surface for one run: the agent's own tools, then the client's.

    A client tool that shares a name with a backend tool is dropped, so the
    agent's schema wins. An older desktop still sends ``getStorageStats``, and
    keeping both would put two definitions of one function in front of the
    model.
    """
    extra = [t for t in (client_tools or []) if getattr(t, "name", None) not in SERVER_TOOL_NAMES]
    return [*SERVER_TOOLS, *extra]

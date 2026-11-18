"""Tool families: the unit selected by group retrieval.

Ranking 40 tools one by one did not work (see README). Here the tools are
grouped into families of things a user asks for, and whole families are bound.
A family's description is what gets embedded (or put to the decision model), so
it is written in the user's vocabulary, not the tool schema's.

Every tool of the snapshot belongs to exactly one family
(``check_covers`` enforces it). ``ALWAYS`` tools are bound whatever is selected.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Bound on every turn. The clock is needed by any relative-time request but
#: nothing in "last hour" is about a clock. applySimulatedTrajectory is never
#: chosen by the model, yet must stay bound: the agent synthesizes the call.
ALWAYS = ("getCurrentDateTime", "applySimulatedTrajectory")


@dataclass(frozen=True)
class Group:
    name: str
    description: str
    tools: tuple[str, ...]


GROUPS: tuple[Group, ...] = (
    Group(
        "live_traffic",
        "Aircraft flying right now: current live tracks and active flights, how many planes "
        "are tracked at the moment, which is the highest, lowest, fastest or closest aircraft, "
        "describe the current air traffic, search live flights by callsign, altitude or speed.",
        ("searchLiveFlights",),
    ),
    Group(
        "history_queries",
        "Past traffic stored in the database: how many aircraft or flights were seen today, "
        "yesterday or in the last hours, traffic statistics over a time range, activity per "
        "hour, busiest hour, hourly heatmap, the trajectory or flight history of one aircraft, "
        "how much data and how many position records are stored.",
        (
            "getStorageStats",
            "getAircraftSummary",
            "getFlightSummary",
            "getTrajectory",
            "getTimeDistribution",
            "getHourlyHeatmap",
        ),
    ),
    Group(
        "map_navigation",
        "Move the map or point at an aircraft: pan, center or zoom the map on coordinates or "
        "a place, show an aircraft on the map, select or highlight an aircraft.",
        ("panMapTo", "selectAircraft"),
    ),
    Group(
        "map_layers",
        "What the map draws: show or hide layers such as labels, range lines, density, "
        "history tracks, events or the receiver; set how many hours back the history tracks "
        "reach; filter displayed aircraft by callsign, altitude or speed; colour tracks by "
        "altitude; configure the density heatmap.",
        (
            "setLayerVisibility",
            "setHistoryWindow",
            "setFilters",
            "setColorMode",
            "setDensityConfig",
        ),
    ),
    Group(
        "app_appearance",
        "The application's look and mode: switch between day (light) and night (dark) map "
        "theme, open or close the sidebar panel, switch between live mode and analysis mode.",
        ("setMapTheme", "toggleSidebar", "setActiveMode"),
    ),
    Group(
        "weather",
        "Wind and weather: what the wind is at an altitude, flight level or place, headwind "
        "or crosswind for an aircraft, show or hide the wind layer, wind barbs and particles.",
        ("getWindAloft", "setWeatherLayer"),
    ),
    Group(
        "events",
        "Events of interest: list or search stored events and memos, create a new event or "
        "marker at a location, filter which events are shown by date.",
        ("getEventsOfInterest", "createEventOfInterest", "setEventFilter"),
    ),
    Group(
        "simulation",
        "Simulated aircraft: simulate, generate, create, start or add flights, helicopters, "
        "fighters or airliners with a route; retry or change a simulated trajectory; show "
        "or hide the built-in demo flights.",
        ("generateSimulatedTrajectory", "toggleDemoFlights"),
    ),
    Group(
        "scenarios",
        "Saved simulation scenarios: list, open, create, rename, describe or delete a "
        "scenario; add a generated trajectory to a scenario, remove a track from it, set "
        "when a track starts.",
        (
            "listScenarios",
            "getScenario",
            "createScenario",
            "renameScenario",
            "setScenarioDescription",
            "deleteScenario",
            "addTrajectoryToScenario",
            "removeTrackFromScenario",
            "setTrackStartOffset",
        ),
    ),
    Group(
        "feed",
        "The ADS-B data feed and connection: feed status, is it connected, message rate, "
        "messages received, errors and uptime, start or stop the feed, connection status.",
        ("getFeedStatus", "getFeedMetrics", "startFeed", "stopFeed", "getConnectionStatus"),
    ),
)

GROUP_OF: dict[str, str] = {tool: g.name for g in GROUPS for tool in g.tools}


def check_covers(tool_names: list[str]) -> None:
    """Fail loudly if the tool surface and the families have drifted apart."""
    grouped = [t for g in GROUPS for t in g.tools]
    duplicates = {t for t in grouped if grouped.count(t) > 1}
    missing = set(tool_names) - set(grouped) - set(ALWAYS)
    unknown = set(grouped) - set(tool_names)
    if duplicates or missing or unknown:
        raise SystemExit(
            f"tool families out of date: in two families {sorted(duplicates)}, "
            f"in no family {sorted(missing)}, not in the tool surface {sorted(unknown)}"
        )

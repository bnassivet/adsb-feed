"""Dev/test fallback tool surface for the ADS-B agent.

Two kinds of tool, per AG-UI:

* **Backend tools** live in ``server_tools.py``. That is their single source of
  truth: the agent always binds them, and ``/info`` advertises them. They are
  included in ``TOOLS`` below rather than copied here.
* **Client tools** (``_CLIENT_TOOLS``) are copies of what the desktop
  registers in ``useCopilotTools.ts``. In production CopilotKit sends the real
  ones on every run in ``RunAgentInput.tools``. These copies serve only the
  frontend-less paths (CLI, unit tests, LangGraph Studio). Keep them broadly
  representative, but they are not the source of truth and they will atrophy.
"""

from .server_tools import SERVER_TOOLS

# OpenAI function-calling format
_CLIENT_TOOLS: list[dict] = [
    # --- Read-only queries (Tier 1) ---
    {
        "type": "function",
        "function": {
            "name": "getDetectionRange",
            "description": (
                "Get detection range analysis by compass sector (10-degree sectors). "
                "Shows the maximum distance (nautical miles) aircraft were detected "
                "in each direction from the receiver."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "startMs": {"type": "integer", "description": "Start time ms epoch"},
                    "endMs": {"type": "integer", "description": "End time ms epoch"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "getFeedStatus",
            "description": (
                "Get current feed connection status: is_running, socket status "
                "(connected/degraded/lost), pulsar status."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "getFeedMetrics",
            "description": (
                "Get current feed throughput metrics: messages received, parsed, "
                "errors, messages per second, uptime."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    # --- Mutating actions (Tier 2) ---
    {
        "type": "function",
        "function": {
            "name": "startFeed",
            "description": (
                "Start the ADS-B data feed. Connects to the dump1090 socket and begins "
                "receiving live aircraft positions. Only call when the user explicitly asks."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "stopFeed",
            "description": (
                "Stop the ADS-B data feed. Disconnects from dump1090. "
                "Only call when the user explicitly asks."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "createEventOfInterest",
            "description": (
                "Create a new event of interest marker. Requires at minimum a title "
                "and location coordinates."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Event title"},
                    "description": {"type": "string", "description": "Event description"},
                    "latitude": {"type": "number", "description": "Latitude in degrees"},
                    "longitude": {"type": "number", "description": "Longitude in degrees"},
                },
                "required": ["title", "latitude", "longitude"],
            },
        },
    },
    # --- UI mutation tools (executed client-side) ---
    {
        "type": "function",
        "function": {
            "name": "selectAircraft",
            "description": "Select and highlight an aircraft on the map by its ICAO hex identifier.",
            "parameters": {
                "type": "object",
                "properties": {
                    "hexIdent": {
                        "type": "string",
                        "description": "ICAO hex identifier (e.g. 'A1B2C3')",
                    },
                },
                "required": ["hexIdent"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "setFilters",
            "description": "Update the aircraft display filters to show/hide aircraft by criteria.",
            "parameters": {
                "type": "object",
                "properties": {
                    "callsign": {
                        "type": "string",
                        "description": "Filter by callsign (substring match)",
                    },
                    "altitudeMin": {
                        "type": "number",
                        "description": "Minimum altitude in feet",
                    },
                    "altitudeMax": {
                        "type": "number",
                        "description": "Maximum altitude in feet",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "panMapTo",
            "description": (
                "Pan and zoom the map to a specific location. Use to navigate to "
                "coordinates, an aircraft position, or a point of interest."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "latitude": {
                        "type": "number",
                        "description": "Target latitude in degrees",
                    },
                    "longitude": {
                        "type": "number",
                        "description": "Target longitude in degrees",
                    },
                    "zoom": {
                        "type": "number",
                        "description": "Zoom level (1-18). Defaults to 12.",
                    },
                },
                "required": ["latitude", "longitude"],
            },
        },
    },
    # --- Display control tools (executed client-side) ---
    {
        "type": "function",
        "function": {
            "name": "getConnectionStatus",
            "description": (
                "Get current connection status and display state from the UI "
                "(no backend query). Returns connection status, active mode, "
                "map theme, and sidebar state."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "toggleSidebar",
            "description": "Toggle the left sidebar panel open or closed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "open": {
                        "type": "boolean",
                        "description": "Set true to open, false to close. Omit to toggle.",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "setMapTheme",
            "description": "Set the map theme to light (day) or dark (night) mode.",
            "parameters": {
                "type": "object",
                "properties": {
                    "theme": {
                        "type": "string",
                        "enum": ["light", "dark"],
                        "description": "Map theme: 'light' for day, 'dark' for night",
                    },
                },
                "required": ["theme"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "setActiveMode",
            "description": "Switch between live tracking mode and analysis mode.",
            "parameters": {
                "type": "object",
                "properties": {
                    "mode": {
                        "type": "string",
                        "enum": ["live", "analysis"],
                        "description": "Active mode",
                    },
                },
                "required": ["mode"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "toggleDemoFlights",
            "description": (
                "Show or hide the built-in demo flight layer — a fixed set of "
                "pre-defined canned routes that loop forever. It creates no "
                "aircraft and takes no description of what to fly. Use ONLY "
                "when the user names this demo layer explicitly. If they ask to "
                "start, run, create or simulate flights or aircraft of their "
                "own, use generateSimulatedTrajectory instead. "
                "Omit 'enabled' to toggle."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "enabled": {
                        "type": "boolean",
                        "description": "Set true to start, false to stop. Omit to toggle.",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "setLayerVisibility",
            "description": (
                "Show or hide map layers. Only provided layers are changed; "
                "omitted layers keep their current state. Weather and wind are "
                "not among them: use setWeatherLayer. To change how far back the "
                "history layer reaches (e.g. 'last 4 hours'), use setHistoryWindow."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "positions": {
                        "type": "boolean",
                        "description": (
                            "Show the trail of past positions behind live aircraft "
                            "(aircraft icons stay visible)"
                        ),
                    },
                    "labels": {
                        "type": "boolean",
                        "description": "Show hex ident / callsign labels next to live aircraft",
                    },
                    "rangeLines": {
                        "type": "boolean",
                        "description": "Show distance/bearing lines from the receiver to the selected aircraft",
                    },
                    "history": {
                        "type": "boolean",
                        "description": "Show tracks of aircraft no longer live",
                    },
                    "density": {"type": "boolean", "description": "Show density heatmap"},
                    "simulation": {
                        "type": "boolean",
                        "description": (
                            "Show the built-in demo flight layer (same canned "
                            "routes as toggleDemoFlights); does not generate aircraft"
                        ),
                    },
                    "imported": {"type": "boolean", "description": "Show imported tracks"},
                    "receiver": {"type": "boolean", "description": "Show receiver location"},
                    "events": {"type": "boolean", "description": "Show events of interest"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "setHistoryWindow",
            "description": (
                "Set the time depth of the history tracks layer: show only aircraft "
                "last seen within a window of hours before now (e.g. 'history from "
                "the last 4 hours' -> depthHours=4). Also turns the history layer on. "
                "The window cannot reach further back than the history retention "
                "(retentionHours in context); a deeper request is clamped and the "
                "result says so. Use setLayerVisibility only to hide the layer."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "depthHours": {
                        "type": "number",
                        "description": (
                            "How many hours of history to show, counted back from "
                            "the window's newer end"
                        ),
                    },
                    "endHoursAgo": {
                        "type": "number",
                        "description": (
                            "Newer end of the window in hours before now; omit or 0 "
                            "for 'until now'"
                        ),
                    },
                },
                "required": ["depthHours"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "setColorMode",
            "description": (
                "Set how aircraft tracks are colored. 'plot' colors each position "
                "by altitude; 'track' colors the entire track uniformly."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "liveColorMode": {
                        "type": "string",
                        "enum": ["plot", "track"],
                        "description": "Color mode for live tracks",
                    },
                    "historyColorMode": {
                        "type": "string",
                        "enum": ["plot", "track"],
                        "description": "Color mode for history tracks",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "setDensityConfig",
            "description": (
                "Configure the density heatmap: metric type, altitude range, "
                "and tooltip detail level."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "metric": {
                        "type": "string",
                        "enum": ["positions", "aircraft", "altitude", "altitude_min", "altitude_max"],
                        "description": "What to visualize in the density layer",
                    },
                    "altitudeMin": {
                        "type": "number",
                        "description": "Min altitude filter in feet (0-50000)",
                    },
                    "altitudeMax": {
                        "type": "number",
                        "description": "Max altitude filter in feet (0-50000)",
                    },
                    "tooltipMode": {
                        "type": "string",
                        "enum": ["compact", "extended", "off"],
                        "description": "Tooltip detail level on hover; 'off' shows no tooltip",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "setEventFilter",
            "description": (
                "Configure how events of interest are filtered: "
                "show all, upcoming N days, or a specific time range."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "mode": {
                        "type": "string",
                        "enum": ["all", "upcoming", "range"],
                        "description": "Filter mode",
                    },
                    "upcomingDays": {
                        "type": "number",
                        "description": "Number of days for upcoming filter",
                    },
                    "timeRangeStartMs": {
                        "type": "integer",
                        "description": "Start of time range (ms epoch)",
                    },
                    "timeRangeEndMs": {
                        "type": "integer",
                        "description": "End of time range (ms epoch)",
                    },
                },
            },
        },
    },
    # --- Weather (executed client-side: the snapshot lives in the desktop app) ---
    {
        "type": "function",
        "function": {
            "name": "setWeatherLayer",
            "description": (
                "Show or hide the weather layer (winds aloft from a weather model) "
                "and choose what it draws: the level, wind barbs, and animated wind "
                "particles coloured by speed. Only provided fields change. This is "
                "the only tool that controls weather or wind on the map; to read "
                "wind values use getWindAloft."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "enabled": {
                        "type": "boolean",
                        "description": "Show (true) or hide (false) the weather layer",
                    },
                    "level": {
                        "type": "string",
                        "description": (
                            "'SFC' for the surface, a pressure level such as '250 hPa', "
                            "or a flight level such as 'FL340' (mapped to the nearest "
                            "level available)"
                        ),
                    },
                    "barbs": {
                        "type": "boolean",
                        "description": "Draw wind barbs at the grid points",
                    },
                    "particles": {
                        "type": "boolean",
                        "description": "Animate particles that move with the wind",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "getWindAloft",
            "description": (
                "Read the wind from the weather model: direction it blows FROM "
                "(degrees true) and speed (knots). For an aircraft (hexIdent or "
                "callsign) it reads at the aircraft's own altitude and adds "
                "headwindKt/crosswindKt along its track (negative headwind = "
                "tailwind, negative crosswind = from the left). Otherwise it reads "
                "at a latitude/longitude, or over the receiver when no position is "
                "given, on the level shown on the map unless level or altitudeFt is "
                "given. Read-only: changes nothing on the map."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "hexIdent": {
                        "type": "string",
                        "description": "ICAO hex ident or callsign of a currently tracked aircraft",
                    },
                    "latitude": {
                        "type": "number",
                        "description": "Latitude in degrees (with longitude)",
                    },
                    "longitude": {
                        "type": "number",
                        "description": "Longitude in degrees (with latitude)",
                    },
                    "altitudeFt": {
                        "type": "number",
                        "description": "Pressure altitude in feet; takes precedence over level",
                    },
                    "level": {
                        "type": "string",
                        "description": "'SFC', a pressure level such as '250 hPa', or a flight level such as 'FL340'",
                    },
                },
            },
        },
    },
]

TOOLS: list[dict] = [
    *(
        {
            "type": "function",
            "function": {"name": t.name, "description": t.description, "parameters": t.parameters},
        }
        for t in SERVER_TOOLS
    ),
    *_CLIENT_TOOLS,
]
"""Backend tools first, then the client copies (OpenAI function-calling format)."""


def get_tool_names() -> list[str]:
    """Return list of all tool names."""
    return [t["function"]["name"] for t in TOOLS]

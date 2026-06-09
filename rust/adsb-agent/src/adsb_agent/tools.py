"""Dev/test fallback tool definitions for the ADS-B agent.

In production, the canonical tool surface is the frontend `useFrontendTool`
registrations in `useCopilotTools.ts`; CopilotKit transmits them on every
chat turn via `RunAgentInput.tools` and the agent forwards them to the LLM.
This list is only used when the agent is invoked without a frontend
(CLI / unit tests / health checks). Keep it broadly representative but do
not treat it as the source of truth — it is not, and it will atrophy.
"""

# OpenAI function-calling format
TOOLS: list[dict] = [
    # --- Read-only queries (Tier 1) ---
    {
        "type": "function",
        "function": {
            "name": "getStorageStats",
            "description": (
                "Get database storage statistics: total position count, raw message count, "
                "flight count, event count, file size in bytes, and time range of stored data."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "getAircraftSummary",
            "description": (
                "Get summary of all aircraft seen in a time range. Returns per-aircraft: "
                "hex_ident (ICAO code), callsign, position_count, min/max altitude (feet), "
                "min/max ground_speed (knots), first_seen and last_seen timestamps (ms epoch)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "startMs": {
                        "type": "integer",
                        "description": "Start time in milliseconds since epoch",
                    },
                    "endMs": {
                        "type": "integer",
                        "description": "End time in milliseconds since epoch",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "getFlightSummary",
            "description": (
                "Get flight-level summaries with automatic segmentation (gaps >1 hour split "
                "into separate flights). Returns: flight_id, hex_ident, callsign, "
                "position_count, first/last_seen, min/max altitude, duration."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "hexIdent": {
                        "type": "string",
                        "description": "ICAO hex identifier to filter by (optional)",
                    },
                    "startMs": {
                        "type": "integer",
                        "description": "Start time in milliseconds since epoch",
                    },
                    "endMs": {
                        "type": "integer",
                        "description": "End time in milliseconds since epoch",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "getTimeDistribution",
            "description": (
                "Get temporal distribution of aircraft activity as histogram buckets. "
                "Shows how many aircraft/positions/flights were seen per time bucket."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "metric": {
                        "type": "string",
                        "enum": ["Positions", "Aircraft", "RawMessages", "Flights"],
                        "description": "What to count per bucket",
                    },
                    "startMs": {"type": "integer", "description": "Start time ms epoch"},
                    "endMs": {"type": "integer", "description": "End time ms epoch"},
                },
            },
        },
    },
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
            "name": "getHourlyHeatmap",
            "description": (
                "Get hourly heatmap: aircraft and message counts per day-of-week x hour grid. "
                "Useful for identifying peak activity patterns."
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
            "name": "getTrajectory",
            "description": (
                "Get position history for a single aircraft by hex_ident. "
                "Returns: list of (lat, lon, altitude, speed, track, timestamp) records."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "hexIdent": {
                        "type": "string",
                        "description": "ICAO hex identifier (e.g. 'A1B2C3')",
                    },
                    "startMs": {"type": "integer", "description": "Start time ms epoch"},
                    "endMs": {"type": "integer", "description": "End time ms epoch"},
                },
                "required": ["hexIdent"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "getEventsOfInterest",
            "description": (
                "Get user-created events of interest. Returns events with title, "
                "description, time range, location, category, and linked aircraft."
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
    # --- Date/time utility ---
    {
        "type": "function",
        "function": {
            "name": "getCurrentDateTime",
            "description": (
                "Get the current date, time, timezone, and epoch milliseconds. "
                "Use this to resolve relative time references (e.g. 'last hour', "
                "'today', 'since midnight') into absolute timestamps for other tools."
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
                "Start or stop simulated demo flights on the map. "
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
                "omitted layers keep their current state."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "history": {"type": "boolean", "description": "Show history trails"},
                    "density": {"type": "boolean", "description": "Show density heatmap"},
                    "simulation": {"type": "boolean", "description": "Show simulated tracks"},
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
                        "enum": ["compact", "extended"],
                        "description": "Tooltip detail level",
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
]

def get_tool_names() -> list[str]:
    """Return list of all tool names."""
    return [t["function"]["name"] for t in TOOLS]

"use client";
/**
 * Registers CopilotKit frontend tools that map agent tool calls
 * to Tauri IPC commands and UI display controls. Each tool name
 * matches a definition in the Python agent's tools.py so the LLM
 * can invoke them and CopilotKit routes execution here.
 *
 * Phase 3: Each tool includes a `render` callback that displays
 * a rich card component in the chat instead of raw JSON.
 */
import { createElement, useRef } from "react";
import { useFrontendTool, type ReactFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import {
  getStorageStats,
  getAircraftSummary,
  getFlightSummary,
  getStatus,
  getMetrics,
  getTrajectory,
  startFeed,
  stopFeed,
  getEventsOfInterest,
  createEventOfInterest,
} from "@/lib/commands";
import {
  StorageStatsCard,
  FeedStatusCard,
  FeedMetricsCard,
  AircraftSummaryTable,
  FlightSummaryTable,
  TrajectoryCard,
  ActionConfirmCard,
  DisplaySettingCard,
  EventsCard,
  LiveFlightsCard,
} from "@/components/chat";
import type {
  ActiveMode,
  AircraftTrack,
  AltitudeColorMode,
  DensityMetric,
  DensityTooltipMode,
  EventFilterMode,
  Filters,
} from "@/lib/types";
import { trackKey } from "@/lib/types";

/** Display state + setters passed from page.tsx for UI control tools. */
export interface DisplayToolsConfig {
  // Read-only state
  connectionStatus: string;
  mapTheme: "light" | "dark";
  sidebarOpen: boolean;
  activeMode: ActiveMode;
  showHistory: boolean;
  showDensity: boolean;
  showSimulation: boolean;
  showImported: boolean;
  showReceiver: boolean;
  showEvents: boolean;
  liveColorMode: AltitudeColorMode;
  historyColorMode: AltitudeColorMode;
  densityMetric: DensityMetric;
  densityTooltipMode: DensityTooltipMode;
  densityAltitudeMin: number;
  densityAltitudeMax: number;
  eventFilterMode: EventFilterMode;
  eventUpcomingDays: number;
  eventTimeRangeStart: number;
  eventTimeRangeEnd: number;
  // Setters
  setMapTheme: (v: "light" | "dark") => void;
  setSidebarOpen: (v: boolean) => void;
  setActiveMode: (v: ActiveMode) => void;
  setShowHistory: (fn: (prev: boolean) => boolean) => void;
  setShowDensity: (fn: (prev: boolean) => boolean) => void;
  setShowSimulation: (fn: (prev: boolean) => boolean) => void;
  setShowImported: (fn: (prev: boolean) => boolean) => void;
  setShowReceiver: (fn: (prev: boolean) => boolean) => void;
  setShowEvents: (fn: (prev: boolean) => boolean) => void;
  setLiveColorMode: (v: AltitudeColorMode) => void;
  setHistoryColorMode: (v: AltitudeColorMode) => void;
  setDensityMetric: (v: DensityMetric) => void;
  setDensityTooltipMode: (v: DensityTooltipMode) => void;
  setDensityAltitudeMin: (v: number) => void;
  setDensityAltitudeMax: (v: number) => void;
  setEventFilterMode: (v: EventFilterMode) => void;
  setEventUpcomingDays: (v: number) => void;
  setEventTimeRangeStart: (v: number) => void;
  setEventTimeRangeEnd: (v: number) => void;
  // Track navigation
  tracks: AircraftTrack[];
  setSelectedHexIdents: (v: Set<string>) => void;
  setLastSelectedHexIdent: (v: string | null) => void;
  activeFilters: Filters;
  setActiveFilters: (v: Filters) => void;
  flyTo: (lat: number, lng: number, zoom: number) => void;
}

/** Map CopilotKit ToolCallStatus strings to our card status prop. */
type RenderStatus = "in_progress" | "executing" | "complete";
function toCardStatus(s: string): RenderStatus {
  if (s === "complete") return "complete";
  if (s === "executing") return "executing";
  return "in_progress";
}

/**
 * Wraps useFrontendTool so every handler is guaranteed to:
 *   - return a string (CopilotKit feeds that string back to the LLM as the
 *     tool result message; undefined/null becomes "" and the LLM is left to
 *     guess what happened)
 *   - never throw (an exception short-circuits CopilotKit's follow-up
 *     runAgent, so the LLM only sees the tool call with no result and
 *     hedges with "no data available")
 *   - emit a brief console breadcrumb so future failures are diagnosable
 *     from Tauri devtools without redeploying.
 */
function useSafeFrontendTool<T extends Record<string, unknown> = Record<string, unknown>>(
  tool: ReactFrontendTool<T>,
) {
  const original = tool.handler;
  const wrapped: ReactFrontendTool<T> = {
    ...tool,
    handler: original
      ? async (args, ctx) => {
          try {
            const result = await original(args, ctx);
            const out =
              typeof result === "string"
                ? result
                : result == null
                  ? ""
                  : JSON.stringify(result);
            console.debug(`[copilot-tool] ${tool.name} ok len=${out.length}`);
            return out;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[copilot-tool] ${tool.name} threw:`, msg);
            return JSON.stringify({ error: msg });
          }
        }
      : undefined,
  };
  useFrontendTool(wrapped);
}

export function useCopilotTools(config: DisplayToolsConfig) {
  // CopilotKit's useFrontendTool registers via useEffect with deps that do
  // NOT include the tool object — so the handler closure captured on first
  // render lives forever. Reading state through this ref (updated on every
  // render) lets handlers always see current values without re-registering.
  const configRef = useRef(config);
  configRef.current = config;

  useSafeFrontendTool({
    name: "getStorageStats",
    description:
      "Historical — database overview. Returns counts and metadata for the persistent store: row_count (position records), flight_count (segmented flights ever recorded), event_count (events of interest), file size, and date range. Use flight_count to answer 'how many flights in the database / in total'. Does not reflect currently-active aircraft — use searchLiveFlights for that.",
    handler: async () => {
      const stats = await getStorageStats();
      return JSON.stringify(stats);
    },
    render: (props) =>
      createElement(StorageStatsCard, {
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "getAircraftSummary",
    description:
      "Historical — queries the database. Summary of unique aircraft (by hex_ident) seen in a time range. Returns hex_ident, callsign, position count, altitude/speed ranges, first/last seen timestamps. Either an array (≤50) or { total, showing, data, note }; use total (or array length) to answer 'how many distinct aircraft did we see in [time range]'.",
    parameters: z.object({
      startMs: z.number().optional().describe("Start time in ms since epoch"),
      endMs: z.number().optional().describe("End time in ms since epoch"),
    }),
    handler: async (args) => {
      const summary = await getAircraftSummary(args.startMs, args.endMs);
      if (summary.length > 50) {
        return JSON.stringify({
          total: summary.length,
          showing: 50,
          data: summary.slice(0, 50),
          note: "Showing first 50. Ask to filter by time range or callsign for specific results.",
        });
      }
      return JSON.stringify(summary);
    },
    render: (props) =>
      createElement(AircraftSummaryTable, {
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "getFlightSummary",
    description:
      "Historical — queries the database. Get a summary of flights in a time range, automatically segmented by >1 hour gaps in coverage. Returns either an array of flights (≤30) or { total, showing, data, note }; use total (or array length) to answer 'how many flights were there in [time range]'. Provide startMs/endMs to bound the query — without them this can be expensive.",
    parameters: z.object({
      startMs: z.number().optional().describe("Start time in ms since epoch"),
      endMs: z.number().optional().describe("End time in ms since epoch"),
    }),
    handler: async (args) => {
      const summary = await getFlightSummary({
        start_ms: args.startMs ?? null,
        end_ms: args.endMs ?? null,
      });
      if (summary.length > 30) {
        return JSON.stringify({
          total: summary.length,
          showing: 30,
          data: summary.slice(0, 30),
          note: "Showing first 30 flights.",
        });
      }
      return JSON.stringify(summary);
    },
    render: (props) =>
      createElement(FlightSummaryTable, {
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "getFeedStatus",
    description:
      "Get the current feed connection status (socket and Pulsar connection states, running/stopped).",
    handler: async () => {
      const status = await getStatus();
      return JSON.stringify(status);
    },
    render: (props) =>
      createElement(FeedStatusCard, {
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "getFeedMetrics",
    description:
      "Get feed performance metrics: messages received/sent, errors, uptime, throughput.",
    handler: async () => {
      const m = await getMetrics();
      return JSON.stringify(m);
    },
    render: (props) =>
      createElement(FeedMetricsCard, {
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "getTrajectory",
    description:
      "Get the position history (trajectory) of a specific aircraft. Returns list of lat/lon/altitude/speed/timestamp records.",
    parameters: z.object({
      hexIdent: z.string().describe("Aircraft hex identifier (ICAO)"),
      startMs: z.number().optional().describe("Start time in ms since epoch"),
      endMs: z.number().optional().describe("End time in ms since epoch"),
    }),
    handler: async (args) => {
      const trajectory = await getTrajectory({
        hex_ident: args.hexIdent,
        start_ms: args.startMs ?? null,
        end_ms: args.endMs ?? null,
      });
      if (trajectory.length > 200) {
        return JSON.stringify({
          total: trajectory.length,
          showing: 200,
          data: trajectory.slice(0, 200),
          note: "Showing first 200 positions. Narrow the time range for more detail.",
        });
      }
      return JSON.stringify(trajectory);
    },
    render: (props) =>
      createElement(TrajectoryCard, {
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "getEventsOfInterest",
    description:
      "Search events of interest stored in the database. Filter by time range and/or category. Returns event title, description, location, category, linked aircraft, and timestamps.",
    parameters: z.object({
      startMs: z.number().optional().describe("Start time in ms since epoch"),
      endMs: z.number().optional().describe("End time in ms since epoch"),
      category: z.string().optional().describe("Filter by event category"),
    }),
    handler: async (args: { startMs?: number; endMs?: number; category?: string }) => {
      const events = await getEventsOfInterest({
        start_ms: args.startMs ?? null,
        end_ms: args.endMs ?? null,
        category: args.category ?? null,
      });
      if (events.length > 20) {
        return JSON.stringify({
          total: events.length,
          showing: 20,
          data: events.slice(0, 20),
          note: "Showing first 20 events. Narrow the time range or add a category filter for more specific results.",
        });
      }
      return JSON.stringify(events);
    },
    render: (props) =>
      createElement(EventsCard, {
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "createEventOfInterest",
    description:
      "Create a new event of interest marker. Requires a title and location. Only call when the user explicitly asks to create an event.",
    parameters: z.object({
      title: z.string().describe("Event title"),
      description: z.string().optional().describe("Event description"),
      latitude: z.number().describe("Latitude in degrees"),
      longitude: z.number().describe("Longitude in degrees"),
      category: z.string().optional().describe("Event category"),
      linkedHexIdents: z.string().optional().describe("Comma-separated ICAO hex identifiers of linked aircraft"),
    }),
    handler: async (args: {
      title: string;
      description?: string;
      latitude: number;
      longitude: number;
      category?: string;
      linkedHexIdents?: string;
    }) => {
      const event = await createEventOfInterest({
        title: args.title,
        description: args.description ?? "",
        timestamp_ms: Date.now(),
        latitude: args.latitude,
        longitude: args.longitude,
        category: args.category ?? null,
        linked_hex_idents: args.linkedHexIdents ?? null,
      });
      return JSON.stringify(event);
    },
    render: (props) =>
      createElement(ActionConfirmCard, {
        action: "start",
        status: toCardStatus(props.status),
        result: props.status === "complete" ? "Event created successfully." : props.result,
      }),
  });

  // --- Track navigation tools ---

  useSafeFrontendTool({
    name: "selectAircraft",
    description:
      "Select and highlight an aircraft on the map by its ICAO hex identifier. The aircraft must be currently visible in the tracked list.",
    parameters: z.object({
      hexIdent: z.string().describe("ICAO hex identifier (e.g. 'A1B2C3')"),
    }),
    handler: async (args: { hexIdent: string }) => {
      const found = configRef.current.tracks.find(
        (t) => trackKey(t) === args.hexIdent
      );
      if (!found) {
        return JSON.stringify({
          error: `Aircraft ${args.hexIdent} not found in current tracks`,
        });
      }
      configRef.current.setSelectedHexIdents(new Set([args.hexIdent]));
      configRef.current.setLastSelectedHexIdent(args.hexIdent);
      return JSON.stringify({
        selected: args.hexIdent,
        callsign: found.callsign ?? null,
        altitude: found.altitude,
        position:
          found.latitude != null && found.longitude != null
            ? { lat: found.latitude, lng: found.longitude }
            : null,
      });
    },
    render: (props) =>
      createElement(DisplaySettingCard, {
        setting: "Select Aircraft",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "searchLiveFlights",
    description:
      "Live — currently tracked aircraft (in-memory). Search, count, and list active flights. Filter by callsign, altitude/speed/heading ranges, squawk, or airborne/ground status; sort by altitude/speed/callsign/messages/recency. Returns { total, showing, flights } — use the total field to answer 'how many planes are flying right now' or 'how many active flights'. Call with no parameters to list all active flights. Returns total: 0 if the data feed is stopped.",
    parameters: z.object({
      callsign: z.string().optional().describe("Substring match on callsign or hex ident (case-insensitive)"),
      altitudeMin: z.number().optional().describe("Minimum altitude in feet"),
      altitudeMax: z.number().optional().describe("Maximum altitude in feet"),
      speedMin: z.number().optional().describe("Minimum ground speed in knots"),
      speedMax: z.number().optional().describe("Maximum ground speed in knots"),
      onGround: z.boolean().optional().describe("Filter by ground status: true=on ground, false=airborne"),
      squawk: z.string().optional().describe("Exact squawk code match (e.g. '7700')"),
      headingMin: z.number().optional().describe("Minimum track heading in degrees (0-360)"),
      headingMax: z.number().optional().describe("Maximum track heading in degrees (0-360)"),
      sortBy: z.enum(["altitude", "speed", "callsign", "messages", "recent"]).optional().describe("Sort field"),
      sortOrder: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: desc)"),
      limit: z.number().optional().describe("Maximum results to return (default: 20)"),
    }),
    handler: async (args: {
      callsign?: string;
      altitudeMin?: number;
      altitudeMax?: number;
      speedMin?: number;
      speedMax?: number;
      onGround?: boolean;
      squawk?: string;
      headingMin?: number;
      headingMax?: number;
      sortBy?: "altitude" | "speed" | "callsign" | "messages" | "recent";
      sortOrder?: "asc" | "desc";
      limit?: number;
    }) => {
      let filtered = [...configRef.current.tracks];

      // Callsign/hex substring filter
      if (args.callsign) {
        const query = args.callsign.toLowerCase();
        filtered = filtered.filter((t) => {
          const cs = (t.callsign ?? "").toLowerCase();
          const hex = t.hex_ident.toLowerCase();
          return cs.includes(query) || hex.includes(query);
        });
      }

      // Altitude range
      if (args.altitudeMin !== undefined) {
        filtered = filtered.filter((t) => t.altitude != null && t.altitude >= args.altitudeMin!);
      }
      if (args.altitudeMax !== undefined) {
        filtered = filtered.filter((t) => t.altitude != null && t.altitude <= args.altitudeMax!);
      }

      // Speed range
      if (args.speedMin !== undefined) {
        filtered = filtered.filter((t) => t.ground_speed != null && t.ground_speed >= args.speedMin!);
      }
      if (args.speedMax !== undefined) {
        filtered = filtered.filter((t) => t.ground_speed != null && t.ground_speed <= args.speedMax!);
      }

      // On ground filter
      if (args.onGround !== undefined) {
        filtered = filtered.filter((t) => t.is_on_ground === args.onGround);
      }

      // Squawk exact match
      if (args.squawk) {
        filtered = filtered.filter((t) => t.squawk === args.squawk);
      }

      // Heading range
      if (args.headingMin !== undefined && args.headingMax !== undefined) {
        filtered = filtered.filter((t) => {
          if (t.track == null) return false;
          if (args.headingMin! <= args.headingMax!) {
            return t.track >= args.headingMin! && t.track <= args.headingMax!;
          }
          // Wrapping range (e.g. 350-10 = northbound)
          return t.track >= args.headingMin! || t.track <= args.headingMax!;
        });
      } else if (args.headingMin !== undefined) {
        filtered = filtered.filter((t) => t.track != null && t.track >= args.headingMin!);
      } else if (args.headingMax !== undefined) {
        filtered = filtered.filter((t) => t.track != null && t.track <= args.headingMax!);
      }

      const total = filtered.length;

      // Sort
      const sortOrder = args.sortOrder ?? "desc";
      const multiplier = sortOrder === "asc" ? 1 : -1;
      if (args.sortBy) {
        filtered.sort((a, b) => {
          let va: number | string = 0;
          let vb: number | string = 0;
          switch (args.sortBy) {
            case "altitude":
              va = a.altitude ?? -1;
              vb = b.altitude ?? -1;
              break;
            case "speed":
              va = a.ground_speed ?? -1;
              vb = b.ground_speed ?? -1;
              break;
            case "callsign":
              va = (a.callsign ?? a.hex_ident).toLowerCase();
              vb = (b.callsign ?? b.hex_ident).toLowerCase();
              return multiplier * (va < vb ? -1 : va > vb ? 1 : 0);
            case "messages":
              va = a.message_count;
              vb = b.message_count;
              break;
            case "recent":
              va = a.last_seen;
              vb = b.last_seen;
              break;
          }
          return multiplier * ((va as number) - (vb as number));
        });
      }

      const limit = args.limit ?? 20;
      const sliced = filtered.slice(0, limit);

      const flights = sliced.map((t) => ({
        hex_ident: t.hex_ident,
        callsign: t.callsign,
        altitude: t.altitude,
        ground_speed: t.ground_speed,
        track: t.track,
        latitude: t.latitude,
        longitude: t.longitude,
        vertical_rate: t.vertical_rate,
        squawk: t.squawk,
        is_on_ground: t.is_on_ground,
        message_count: t.message_count,
        first_seen: t.first_seen,
        last_seen: t.last_seen,
        positionCount: Array.isArray(t.positions) ? t.positions.length : t.positions.length,
      }));

      return JSON.stringify({ total, showing: sliced.length, flights });
    },
    render: (props) =>
      createElement(LiveFlightsCard, {
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "setFilters",
    description:
      "Update aircraft display filters. Filters by callsign (substring match), altitude range, and speed range. Only provided fields are changed; omitted fields keep their current value.",
    parameters: z.object({
      callsign: z.string().optional().describe("Filter by callsign or hex ident (substring match)"),
      altitudeMin: z.number().optional().describe("Minimum altitude in feet"),
      altitudeMax: z.number().optional().describe("Maximum altitude in feet"),
      speedMin: z.number().optional().describe("Minimum ground speed in knots"),
      speedMax: z.number().optional().describe("Maximum ground speed in knots"),
    }),
    handler: async (args: {
      callsign?: string;
      altitudeMin?: number;
      altitudeMax?: number;
      speedMin?: number;
      speedMax?: number;
    }) => {
      const newFilters: Filters = {
        ...configRef.current.activeFilters,
        ...(args.callsign !== undefined && { callsign: args.callsign }),
        ...(args.altitudeMin !== undefined && { altitudeMin: args.altitudeMin }),
        ...(args.altitudeMax !== undefined && { altitudeMax: args.altitudeMax }),
        ...(args.speedMin !== undefined && { speedMin: args.speedMin }),
        ...(args.speedMax !== undefined && { speedMax: args.speedMax }),
      };
      configRef.current.setActiveFilters(newFilters);
      return JSON.stringify(newFilters);
    },
    render: (props) =>
      createElement(DisplaySettingCard, {
        setting: "Filters",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "panMapTo",
    description:
      "Pan and zoom the map to a specific location. Use to navigate to coordinates, an aircraft position, or a point of interest.",
    parameters: z.object({
      latitude: z.number().describe("Target latitude in degrees"),
      longitude: z.number().describe("Target longitude in degrees"),
      zoom: z.number().optional().describe("Zoom level (1-18). Defaults to 12."),
    }),
    handler: async (args: { latitude: number; longitude: number; zoom?: number }) => {
      const zoom = args.zoom ?? 12;
      configRef.current.flyTo(args.latitude, args.longitude, zoom);
      return JSON.stringify({
        latitude: args.latitude,
        longitude: args.longitude,
        zoom,
      });
    },
    render: (props) =>
      createElement(DisplaySettingCard, {
        setting: "Map Navigation",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "startFeed",
    description:
      "Start the ADS-B feed connection. Only call when the user explicitly asks to start the feed.",
    handler: async () => {
      await startFeed();
      return "Feed started successfully.";
    },
    render: (props) =>
      createElement(ActionConfirmCard, {
        action: "start",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "stopFeed",
    description:
      "Stop the ADS-B feed connection. Only call when the user explicitly asks to stop the feed.",
    handler: async () => {
      await stopFeed();
      return "Feed stopped successfully.";
    },
    render: (props) =>
      createElement(ActionConfirmCard, {
        action: "stop",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  // --- Date/time utility ---

  useSafeFrontendTool({
    name: "getCurrentDateTime",
    description:
      "Get the current date, time, timezone, and epoch milliseconds. Use this to resolve relative time references (e.g. 'last hour', 'today') into absolute timestamps for other tools.",
    handler: async () => {
      const now = new Date();
      return JSON.stringify({
        epochMs: now.getTime(),
        iso8601: now.toISOString(),
        date: now.toLocaleDateString(),
        time: now.toLocaleTimeString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    },
    render: (props) =>
      createElement(DisplaySettingCard, {
        setting: "Current Date/Time",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  // --- Display control tools ---

  useSafeFrontendTool({
    name: "getConnectionStatus",
    description:
      "Get current connection status and display state without querying the backend. Returns connection status, active mode, map theme, and sidebar state.",
    handler: async () =>
      JSON.stringify({
        connectionStatus: configRef.current.connectionStatus,
        activeMode: configRef.current.activeMode,
        mapTheme: configRef.current.mapTheme,
        sidebarOpen: configRef.current.sidebarOpen,
      }),
    render: (props) =>
      createElement(DisplaySettingCard, {
        setting: "Connection Status",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "toggleSidebar",
    description:
      "Toggle the left sidebar panel open or closed. Omit 'open' to toggle.",
    parameters: z.object({
      open: z
        .boolean()
        .optional()
        .describe("Set to true to open, false to close. Omit to toggle."),
    }),
    handler: async (args: { open?: boolean }) => {
      const newValue = args.open ?? !configRef.current.sidebarOpen;
      configRef.current.setSidebarOpen(newValue);
      return JSON.stringify({ sidebarOpen: newValue });
    },
    render: (props) =>
      createElement(DisplaySettingCard, {
        setting: "Sidebar",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "setMapTheme",
    description:
      "Set the map theme to light (day) or dark (night) mode.",
    parameters: z.object({
      theme: z.enum(["light", "dark"]).describe("Map theme: 'light' for day, 'dark' for night"),
    }),
    handler: async (args: { theme: "light" | "dark" }) => {
      configRef.current.setMapTheme(args.theme);
      return JSON.stringify({ mapTheme: args.theme });
    },
    render: (props) =>
      createElement(DisplaySettingCard, {
        setting: "Map Theme",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "setActiveMode",
    description:
      "Switch between live tracking mode and analysis mode.",
    parameters: z.object({
      mode: z.enum(["live", "analysis"]).describe("Active mode"),
    }),
    handler: async (args: { mode: ActiveMode }) => {
      configRef.current.setActiveMode(args.mode);
      return JSON.stringify({ activeMode: args.mode });
    },
    render: (props) =>
      createElement(DisplaySettingCard, {
        setting: "Active Mode",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "toggleDemoFlights",
    description:
      "Start or stop simulated demo flights on the map. Omit 'enabled' to toggle.",
    parameters: z.object({
      enabled: z
        .boolean()
        .optional()
        .describe("Set to true to start, false to stop. Omit to toggle."),
    }),
    handler: async (args: { enabled?: boolean }) => {
      const newValue = args.enabled ?? !configRef.current.showSimulation;
      configRef.current.setShowSimulation(() => newValue);
      return JSON.stringify({ demoFlights: newValue });
    },
    render: (props) =>
      createElement(DisplaySettingCard, {
        setting: "Demo Flights",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "setLayerVisibility",
    description:
      "Show or hide map layers. Only provided layers are changed; omitted layers keep their current state. Available layers: history, density, simulation, imported, receiver, events.",
    parameters: z.object({
      history: z.boolean().optional().describe("Show history trails"),
      density: z.boolean().optional().describe("Show density heatmap"),
      simulation: z.boolean().optional().describe("Show simulated tracks"),
      imported: z.boolean().optional().describe("Show imported tracks"),
      receiver: z.boolean().optional().describe("Show receiver location marker"),
      events: z.boolean().optional().describe("Show events of interest"),
    }),
    handler: async (args: {
      history?: boolean;
      density?: boolean;
      simulation?: boolean;
      imported?: boolean;
      receiver?: boolean;
      events?: boolean;
    }) => {
      const changes: Record<string, boolean> = {};
      if (args.history !== undefined) {
        configRef.current.setShowHistory(() => args.history!);
        changes.history = args.history!;
      }
      if (args.density !== undefined) {
        configRef.current.setShowDensity(() => args.density!);
        changes.density = args.density!;
      }
      if (args.simulation !== undefined) {
        configRef.current.setShowSimulation(() => args.simulation!);
        changes.simulation = args.simulation!;
      }
      if (args.imported !== undefined) {
        configRef.current.setShowImported(() => args.imported!);
        changes.imported = args.imported!;
      }
      if (args.receiver !== undefined) {
        configRef.current.setShowReceiver(() => args.receiver!);
        changes.receiver = args.receiver!;
      }
      if (args.events !== undefined) {
        configRef.current.setShowEvents(() => args.events!);
        changes.events = args.events!;
      }
      return JSON.stringify({ updated: changes });
    },
    render: (props) =>
      createElement(DisplaySettingCard, {
        setting: "Layer Visibility",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "setColorMode",
    description:
      "Set how aircraft tracks are colored. 'plot' colors each position by altitude; 'track' colors the entire track uniformly.",
    parameters: z.object({
      liveColorMode: z
        .enum(["plot", "track"])
        .optional()
        .describe("Color mode for live tracks"),
      historyColorMode: z
        .enum(["plot", "track"])
        .optional()
        .describe("Color mode for history tracks"),
    }),
    handler: async (args: {
      liveColorMode?: AltitudeColorMode;
      historyColorMode?: AltitudeColorMode;
    }) => {
      if (args.liveColorMode) configRef.current.setLiveColorMode(args.liveColorMode);
      if (args.historyColorMode)
        configRef.current.setHistoryColorMode(args.historyColorMode);
      return JSON.stringify({
        liveColorMode: args.liveColorMode ?? configRef.current.liveColorMode,
        historyColorMode: args.historyColorMode ?? configRef.current.historyColorMode,
      });
    },
    render: (props) =>
      createElement(DisplaySettingCard, {
        setting: "Color Mode",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "setDensityConfig",
    description:
      "Configure the density heatmap: metric type, altitude range filter, and tooltip detail level.",
    parameters: z.object({
      metric: z
        .enum(["positions", "aircraft", "altitude", "altitude_min", "altitude_max"])
        .optional()
        .describe("What to visualize in the density layer"),
      altitudeMin: z.number().optional().describe("Min altitude filter in feet (0-50000)"),
      altitudeMax: z.number().optional().describe("Max altitude filter in feet (0-50000)"),
      tooltipMode: z
        .enum(["compact", "extended"])
        .optional()
        .describe("Tooltip detail level"),
    }),
    handler: async (args: {
      metric?: DensityMetric;
      altitudeMin?: number;
      altitudeMax?: number;
      tooltipMode?: DensityTooltipMode;
    }) => {
      if (args.metric) configRef.current.setDensityMetric(args.metric);
      if (args.altitudeMin !== undefined)
        configRef.current.setDensityAltitudeMin(args.altitudeMin);
      if (args.altitudeMax !== undefined)
        configRef.current.setDensityAltitudeMax(args.altitudeMax);
      if (args.tooltipMode) configRef.current.setDensityTooltipMode(args.tooltipMode);
      return JSON.stringify({
        metric: args.metric ?? configRef.current.densityMetric,
        altitudeMin: args.altitudeMin ?? configRef.current.densityAltitudeMin,
        altitudeMax: args.altitudeMax ?? configRef.current.densityAltitudeMax,
        tooltipMode: args.tooltipMode ?? configRef.current.densityTooltipMode,
      });
    },
    render: (props) =>
      createElement(DisplaySettingCard, {
        setting: "Density Config",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });

  useSafeFrontendTool({
    name: "setEventFilter",
    description:
      "Configure how events of interest are filtered: show all, upcoming N days, or a specific time range.",
    parameters: z.object({
      mode: z
        .enum(["all", "upcoming", "range"])
        .optional()
        .describe("Filter mode"),
      upcomingDays: z.number().optional().describe("Number of days for upcoming filter"),
      timeRangeStartMs: z
        .number()
        .optional()
        .describe("Start of time range in ms since epoch"),
      timeRangeEndMs: z
        .number()
        .optional()
        .describe("End of time range in ms since epoch"),
    }),
    handler: async (args: {
      mode?: EventFilterMode;
      upcomingDays?: number;
      timeRangeStartMs?: number;
      timeRangeEndMs?: number;
    }) => {
      if (args.mode) configRef.current.setEventFilterMode(args.mode);
      if (args.upcomingDays !== undefined)
        configRef.current.setEventUpcomingDays(args.upcomingDays);
      if (args.timeRangeStartMs !== undefined)
        configRef.current.setEventTimeRangeStart(args.timeRangeStartMs);
      if (args.timeRangeEndMs !== undefined)
        configRef.current.setEventTimeRangeEnd(args.timeRangeEndMs);
      return JSON.stringify({
        mode: args.mode ?? configRef.current.eventFilterMode,
        upcomingDays: args.upcomingDays ?? configRef.current.eventUpcomingDays,
      });
    },
    render: (props) =>
      createElement(DisplaySettingCard, {
        setting: "Event Filter",
        status: toCardStatus(props.status),
        result: props.result,
      }),
  });
}

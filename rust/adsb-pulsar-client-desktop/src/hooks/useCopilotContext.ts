"use client";
/**
 * Registers CopilotKit readables that publish ambient UI state to the agent
 * on every chat turn. CopilotKit bundles these into RunAgentInput.context,
 * the agent renders them into the system prompt (see system_prompt.py /
 * system_prompt.md.j2). The LLM then knows the current mode, selection,
 * filters, and feed status without making a tool call.
 *
 * One useAgentContext call per concern: easier for the LLM to parse than one
 * giant blob, and lets future fields be added or removed independently.
 */
import { useAgentContext } from "@copilotkit/react-core/v2";
import type {
  ActiveMode,
  AircraftTrack,
  Filters,
  StorageAvailability,
} from "@/lib/types";
import {
  describeRecordedValidity,
  describeValidity,
  isOffHour,
  isStale,
  levelLabel,
  type WeatherAvailability,
  type WeatherLevel,
  type WeatherSnapshot,
} from "@/lib/weather";

/** The weather layer as the agent should see it. */
export interface CopilotWeatherContext {
  snapshot: WeatherSnapshot | null;
  availability: WeatherAvailability;
  show: boolean;
  level: WeatherLevel;
  showBarbs: boolean;
  showParticles: boolean;
  /** The page's weather clock: reading Date.now() here would be impure. */
  nowMs: number;
  /**
   * False while the view is showing recorded weather.
   *
   * Optional, defaulting to live, so a caller that omits it cannot silently
   * change what the agent is told about a live session.
   */
  isLive?: boolean;
  /** The instant on screen while browsing; null while live. */
  viewTimeMs?: number | null;
}

/**
 * The invariant this defends: **the agent sees what the map shows.**
 *
 * Leaving it live-only would reproduce the map's bug in prose, which is worse
 * — text carries no visual cue that it is describing the wrong day.
 */
function weatherValue(weather: CopilotWeatherContext | undefined) {
  if (!weather) return "unavailable in this view";
  const { nowMs, snapshot } = weather;
  const isLive = weather.isLive !== false;
  const viewTimeMs = weather.viewTimeMs ?? null;

  // A statement about the live plane only: recorded weather comes out of
  // DuckDB, so a socket session can still browse hours recorded earlier.
  if (weather.availability === "unsupported_source" && isLive) {
    return "unsupported: weather arrives over the MQTT live source, and the app is reading dump1090 directly";
  }

  const recorded = !isLive && viewTimeMs !== null;
  return {
    mode: isLive ? "live" : "history",
    availability: weather.availability,
    shown: weather.show,
    level: levelLabel(weather.level),
    barbs: weather.showBarbs,
    particles: weather.showParticles,
    validity: snapshot
      ? recorded
        ? describeRecordedValidity(snapshot.valid_time_ms, viewTimeMs)
        : describeValidity(snapshot.valid_time_ms, nowMs)
      : isLive
        ? "waiting for the first weather snapshot"
        : "no weather was recorded for the time being viewed",
    // Staleness is a live question. Browsing asks a different one: how far the
    // nearest recorded hour is from the time on screen, either way.
    stale: snapshot ? (recorded ? isOffHour(snapshot, viewTimeMs) : isStale(snapshot, nowMs)) : false,
  };
}

export interface CopilotContextConfig {
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
  selectedHexIdents: Set<string>;
  lastSelectedHexIdent: string | null;
  activeFilters: Filters;
  tracks: AircraftTrack[];
  storageStatus: StorageAvailability;
  /** Receiver location — the agent needs it to anchor generated routes. */
  receiverLocation: { lat: number; lng: number } | null;
  /** How many agent-generated simulated aircraft are currently playing. */
  agentSimulatedCount: number;
  /** The weather layer. Absent when the page does not provide one. */
  weather?: CopilotWeatherContext;
}

export function useCopilotContext(config: CopilotContextConfig) {
  useAgentContext({
    description: "Active mode (live or analysis)",
    value: config.activeMode,
  });

  useAgentContext({
    description: "Feed connection status",
    value: config.connectionStatus,
  });

  useAgentContext({
    description: "Database storage availability",
    value: config.storageStatus,
  });

  useAgentContext({
    description:
      "Selected aircraft (hex idents) and the most recently selected one",
    value: {
      selected: Array.from(config.selectedHexIdents),
      lastSelected: config.lastSelectedHexIdent,
    },
  });

  useAgentContext({
    description:
      "Active aircraft filters (callsign, altitude range, speed range)",
    value: { ...config.activeFilters },
  });

  useAgentContext({
    description: "Map theme and sidebar state",
    value: { mapTheme: config.mapTheme, sidebarOpen: config.sidebarOpen },
  });

  useAgentContext({
    description:
      "Visible map layers (history, density, simulation, imported, receiver, events)",
    value: {
      history: config.showHistory,
      density: config.showDensity,
      simulation: config.showSimulation,
      imported: config.showImported,
      receiver: config.showReceiver,
      events: config.showEvents,
    },
  });

  useAgentContext({
    description: "Live aircraft track count",
    value: { trackCount: config.tracks.length },
  });

  useAgentContext({
    description:
      "Receiver (antenna) location as lat/lng. Pass these as originLat/originLng " +
      "when generating simulated trajectories so demo aircraft appear locally.",
    value: config.receiverLocation
      ? `${config.receiverLocation.lat}, ${config.receiverLocation.lng}`
      : "not configured",
  });

  useAgentContext({
    description: "Number of agent-generated simulated aircraft currently on the map",
    value: config.agentSimulatedCount,
  });

  useAgentContext({
    description:
      "Weather layer (winds aloft): availability, what it draws, and how current the data is",
    value: weatherValue(config.weather),
  });

}

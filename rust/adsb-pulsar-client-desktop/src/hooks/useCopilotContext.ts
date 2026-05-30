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
}

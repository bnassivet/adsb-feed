"use client";
/**
 * Provides live app state to the CopilotKit agent context
 * so the LLM can see real-time information without making tool calls.
 */
import { useAgentContext, type JsonSerializable } from "@copilotkit/react-core/v2";
import type { ActiveMode, StorageAvailability } from "@/lib/types";

interface DisplayState {
  mapTheme: "light" | "dark";
  sidebarOpen: boolean;
  layers: {
    history: boolean;
    density: boolean;
    simulation: boolean;
    imported: boolean;
    receiver: boolean;
    events: boolean;
  };
  liveColorMode: string;
  historyColorMode: string;
  densityMetric: string;
  eventFilterMode: string;
}

interface CopilotContextProps {
  liveTrackCount: number;
  connectionStatus: string;
  activeMode: ActiveMode;
  storageStatus: StorageAvailability;
  receiverLocation?: { lat: number; lng: number; alt?: number | null };
  displayState: DisplayState;
}

export function useCopilotContext({
  liveTrackCount,
  connectionStatus,
  activeMode,
  storageStatus,
  receiverLocation,
  displayState,
}: CopilotContextProps) {
  useAgentContext({
    description:
      "Current app state: live aircraft count, feed connection status, active mode (live/analysis), storage availability, receiver location, and display settings (theme, layers, color modes).",
    value: {
      liveTrackCount,
      connectionStatus,
      activeMode,
      storageStatus,
      ...(receiverLocation ? { receiverLocation } : {}),
      displayState,
    } as unknown as JsonSerializable,
  });
}

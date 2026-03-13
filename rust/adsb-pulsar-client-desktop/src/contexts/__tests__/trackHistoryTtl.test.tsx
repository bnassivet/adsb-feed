import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import { renderHook, act } from "@testing-library/react";
import { mockInvokeResponse, clearMockResponses, emitMockEvent } from "@/test/mocks/tauri";
import {
  AircraftTrackingProvider,
  useAircraftTrackingContext,
  TRACK_HISTORY_HOURS_KEY,
  DEFAULT_TRACK_HISTORY_HOURS,
} from "../AircraftTrackingContext";
import type { AircraftPosition } from "@/lib/types";

const CLEANUP_INTERVAL_MS = 15_000;

function wrapper({ children }: { children: React.ReactNode }) {
  return <AircraftTrackingProvider>{children}</AircraftTrackingProvider>;
}

function makePosition(hex: string, overrides: Partial<AircraftPosition> = {}): AircraftPosition {
  return {
    hex_ident: hex,
    callsign: null,
    altitude: 35000,
    ground_speed: 450,
    track: 90,
    latitude: 45.5,
    longitude: -73.5,
    vertical_rate: 0,
    squawk: null,
    is_on_ground: false,
    timestamp: "2024-01-15 10:30:00",
    message_count: 1,
    ...overrides,
  };
}

describe("configurable track history TTL", () => {
  beforeEach(() => {
    localStorage.clear();
    clearMockResponses();
    mockInvokeResponse("query_bbox", []);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports the localStorage key and default value constants", () => {
    expect(TRACK_HISTORY_HOURS_KEY).toBe("adsb-track-history-hours");
    expect(DEFAULT_TRACK_HISTORY_HOURS).toBe(24);
  });

  it("exposes trackHistoryHours and setTrackHistoryHours in context", () => {
    const { result } = renderHook(() => useAircraftTrackingContext(), { wrapper });

    expect(result.current.trackHistoryHours).toBe(24);
    expect(typeof result.current.setTrackHistoryHours).toBe("function");
  });

  it("reads trackHistoryHours from localStorage if set", () => {
    localStorage.setItem("adsb-track-history-hours", JSON.stringify(12));

    const { result } = renderHook(() => useAircraftTrackingContext(), { wrapper });

    expect(result.current.trackHistoryHours).toBe(12);
  });

  it("persists trackHistoryHours to localStorage when changed", () => {
    const { result } = renderHook(() => useAircraftTrackingContext(), { wrapper });

    act(() => {
      result.current.setTrackHistoryHours(6);
    });

    expect(result.current.trackHistoryHours).toBe(6);
    expect(JSON.parse(localStorage.getItem("adsb-track-history-hours")!)).toBe(6);
  });

  it("uses custom TTL for history cleanup", () => {
    // Set history to 1 hour
    localStorage.setItem("adsb-track-history-hours", JSON.stringify(1));

    const { result } = renderHook(() => useAircraftTrackingContext(), { wrapper });

    // Inject a track into the active map, then let it expire to history
    act(() => {
      emitMockEvent("adsb:message", [makePosition("HIST01")]);
    });
    expect(result.current.tracks.size).toBe(1);

    // Advance past active TTL (5 min) + cleanup interval (15s) to trigger the cleanup
    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000 + CLEANUP_INTERVAL_MS);
    });
    expect(result.current.history.has("HIST01")).toBe(true);

    // Advance past 1h history TTL + cleanup interval
    act(() => {
      vi.advanceTimersByTime(1 * 60 * 60 * 1000 + CLEANUP_INTERVAL_MS);
    });
    expect(result.current.history.has("HIST01")).toBe(false);
  });

  it("does NOT clean up history before custom TTL expires", () => {
    // Set history to 2 hours
    localStorage.setItem("adsb-track-history-hours", JSON.stringify(2));

    const { result } = renderHook(() => useAircraftTrackingContext(), { wrapper });

    act(() => {
      emitMockEvent("adsb:message", [makePosition("KEEP01")]);
    });

    // Move to history (past 5 min active TTL + cleanup)
    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000 + CLEANUP_INTERVAL_MS);
    });
    expect(result.current.history.has("KEEP01")).toBe(true);

    // Advance 1 hour — should still be in history (TTL is 2h)
    act(() => {
      vi.advanceTimersByTime(1 * 60 * 60 * 1000);
    });
    expect(result.current.history.has("KEEP01")).toBe(true);

    // Advance past 2h total from last_seen + cleanup interval — now it should be cleaned
    act(() => {
      vi.advanceTimersByTime(1 * 60 * 60 * 1000 + CLEANUP_INTERVAL_MS);
    });
    expect(result.current.history.has("KEEP01")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import React from "react";
import { renderHook, act } from "@testing-library/react";
import { AircraftTrackingProvider, useAircraftTrackingContext } from "../AircraftTrackingContext";
import type { AircraftTrack } from "@/lib/types";

function makeTrack(hex: string): AircraftTrack {
  return {
    hex_ident: hex,
    callsign: `CS-${hex}`,
    altitude: 35000,
    ground_speed: 450,
    track: 90,
    latitude: 45.5,
    longitude: -73.5,
    vertical_rate: 0,
    squawk: "1200",
    is_on_ground: false,
    timestamp: "2024-01-15 10:30:00",
    positions: [[45.5, -73.5, 35000]],
    first_seen: Date.now(),
    last_seen: Date.now(),
    message_count: 10,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <AircraftTrackingProvider>{children}</AircraftTrackingProvider>;
}

describe("dbHistory track category", () => {
  it("loadDbHistoryTracks populates dbHistory map and increments version", () => {
    const { result } = renderHook(() => useAircraftTrackingContext(), { wrapper });

    const initialVersion = result.current.version;

    act(() => {
      result.current.loadDbHistoryTracks([makeTrack("AAA111"), makeTrack("BBB222")]);
    });

    expect(result.current.dbHistory.size).toBe(2);
    expect(result.current.dbHistory.has("AAA111")).toBe(true);
    expect(result.current.dbHistory.has("BBB222")).toBe(true);
    expect(result.current.version).toBeGreaterThan(initialVersion);
  });

  it("clearDbHistory empties map and increments version", () => {
    const { result } = renderHook(() => useAircraftTrackingContext(), { wrapper });

    act(() => {
      result.current.loadDbHistoryTracks([makeTrack("AAA111")]);
    });
    expect(result.current.dbHistory.size).toBe(1);
    const versionAfterLoad = result.current.version;

    act(() => {
      result.current.clearDbHistory();
    });

    expect(result.current.dbHistory.size).toBe(0);
    expect(result.current.version).toBeGreaterThan(versionAfterLoad);
  });

  it("dbHistory and imported are independent", () => {
    const { result } = renderHook(() => useAircraftTrackingContext(), { wrapper });

    act(() => {
      result.current.loadDbHistoryTracks([makeTrack("DB-001")]);
      result.current.importTracks([makeTrack("IMP-001")]);
    });

    expect(result.current.dbHistory.size).toBe(1);
    expect(result.current.dbHistory.has("DB-001")).toBe(true);
    expect(result.current.imported.size).toBe(1);
    expect(result.current.imported.has("IMP-001")).toBe(true);

    // Clearing one doesn't affect the other
    act(() => {
      result.current.clearDbHistory();
    });
    expect(result.current.dbHistory.size).toBe(0);
    expect(result.current.imported.size).toBe(1);
  });
});

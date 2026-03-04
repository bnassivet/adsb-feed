import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { renderHook, act } from "@testing-library/react";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import { AircraftTrackingProvider, useAircraftTrackingContext } from "../AircraftTrackingContext";
import type { AircraftTrack } from "@/lib/types";

function makeTrack(hex: string, overrides: Partial<AircraftTrack> = {}): AircraftTrack {
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
    ...overrides,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <AircraftTrackingProvider>{children}</AircraftTrackingProvider>;
}

describe("analysis track category", () => {
  beforeEach(() => {
    clearMockResponses();
    mockInvokeResponse("query_bbox", []);
  });

  it("addAnalysisTracks is additive: add 2 then add 1 more → 3 total", () => {
    const { result } = renderHook(() => useAircraftTrackingContext(), { wrapper });

    act(() => {
      result.current.addAnalysisTracks([makeTrack("AAA111"), makeTrack("BBB222")]);
    });
    expect(result.current.analysis.size).toBe(2);

    act(() => {
      result.current.addAnalysisTracks([makeTrack("CCC333")]);
    });
    expect(result.current.analysis.size).toBe(3);
    expect(result.current.analysis.has("AAA111")).toBe(true);
    expect(result.current.analysis.has("BBB222")).toBe(true);
    expect(result.current.analysis.has("CCC333")).toBe(true);
  });

  it("addAnalysisTracks overwrites same hex_ident (update, not duplicate)", () => {
    const { result } = renderHook(() => useAircraftTrackingContext(), { wrapper });

    act(() => {
      result.current.addAnalysisTracks([makeTrack("AAA111", { altitude: 30000 })]);
    });
    expect(result.current.analysis.get("AAA111")?.altitude).toBe(30000);

    act(() => {
      result.current.addAnalysisTracks([makeTrack("AAA111", { altitude: 40000 })]);
    });
    expect(result.current.analysis.size).toBe(1);
    expect(result.current.analysis.get("AAA111")?.altitude).toBe(40000);
  });

  it("removeAnalysisTrack removes single track, others remain", () => {
    const { result } = renderHook(() => useAircraftTrackingContext(), { wrapper });

    act(() => {
      result.current.addAnalysisTracks([makeTrack("AAA111"), makeTrack("BBB222"), makeTrack("CCC333")]);
    });
    expect(result.current.analysis.size).toBe(3);

    act(() => {
      result.current.removeAnalysisTrack("BBB222");
    });
    expect(result.current.analysis.size).toBe(2);
    expect(result.current.analysis.has("AAA111")).toBe(true);
    expect(result.current.analysis.has("BBB222")).toBe(false);
    expect(result.current.analysis.has("CCC333")).toBe(true);
  });

  it("clearAnalysis empties the map", () => {
    const { result } = renderHook(() => useAircraftTrackingContext(), { wrapper });

    act(() => {
      result.current.addAnalysisTracks([makeTrack("AAA111"), makeTrack("BBB222")]);
    });
    expect(result.current.analysis.size).toBe(2);

    act(() => {
      result.current.clearAnalysis();
    });
    expect(result.current.analysis.size).toBe(0);
  });

  it("analysis and dbHistory are independent", () => {
    const { result } = renderHook(() => useAircraftTrackingContext(), { wrapper });

    act(() => {
      result.current.addAnalysisTracks([makeTrack("AN-001")]);
      result.current.loadDbHistoryTracks([makeTrack("DB-001")]);
    });

    expect(result.current.analysis.size).toBe(1);
    expect(result.current.analysis.has("AN-001")).toBe(true);
    expect(result.current.dbHistory.size).toBe(1);
    expect(result.current.dbHistory.has("DB-001")).toBe(true);

    act(() => {
      result.current.clearAnalysis();
    });
    expect(result.current.analysis.size).toBe(0);
    expect(result.current.dbHistory.size).toBe(1);
  });
});

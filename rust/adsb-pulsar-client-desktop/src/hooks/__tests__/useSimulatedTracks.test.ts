import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  computeHeading,
  interpolate,
  useSimulatedTracks,
} from "../useSimulatedTracks";
import { SIMULATION_ORIGIN } from "@/lib/simulation-data";

describe("computeHeading", () => {
  it("north direction (lat increases)", () => {
    const heading = computeHeading(0, 0, 1, 0);
    expect(heading).toBeCloseTo(0, 0);
  });

  it("east direction (lng increases)", () => {
    const heading = computeHeading(0, 0, 0, 1);
    expect(heading).toBeCloseTo(90, 0);
  });

  it("south direction (lat decreases)", () => {
    const heading = computeHeading(1, 0, 0, 0);
    expect(heading).toBeCloseTo(180, 0);
  });

  it("west direction (lng decreases)", () => {
    const heading = computeHeading(0, 0, 0, -1);
    expect(heading).toBeCloseTo(270, 0);
  });
});

describe("interpolate", () => {
  it("returns midpoint at t=0.5", () => {
    const result = interpolate([0, 0], [10, 10], 0.5);
    expect(result[0]).toBe(5);
    expect(result[1]).toBe(5);
  });

  it("returns start at t=0", () => {
    const result = interpolate([3, 7], [10, 20], 0);
    expect(result[0]).toBe(3);
    expect(result[1]).toBe(7);
  });

  it("returns end at t=1", () => {
    const result = interpolate([3, 7], [10, 20], 1);
    expect(result[0]).toBe(10);
    expect(result[1]).toBe(20);
  });
});

describe("useSimulatedTracks receiver-relative offset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reproduces today's exact output when receiverLocation is null", () => {
    const { result: withNull } = renderHook(() =>
      useSimulatedTracks(true, null),
    );
    const { result: withoutArg } = renderHook(() =>
      useSimulatedTracks(true),
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(withNull.current[0].latitude).toBe(withoutArg.current[0].latitude);
    expect(withNull.current[0].longitude).toBe(
      withoutArg.current[0].longitude,
    );
  });

  it("offsets tracks by exactly the delta from SIMULATION_ORIGIN to receiverLocation", () => {
    const receiverLocation = { lat: 51.5, lng: -0.12 };

    const { result: baseline } = renderHook(() =>
      useSimulatedTracks(true, null),
    );
    const { result: offset } = renderHook(() =>
      useSimulatedTracks(true, receiverLocation),
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    const dLat = receiverLocation.lat - SIMULATION_ORIGIN.lat;
    const dLng = receiverLocation.lng - SIMULATION_ORIGIN.lng;

    expect(offset.current[0].latitude).toBeCloseTo(
      (baseline.current[0].latitude ?? 0) + dLat,
      10,
    );
    expect(offset.current[0].longitude).toBeCloseTo(
      (baseline.current[0].longitude ?? 0) + dLng,
      10,
    );
  });
});

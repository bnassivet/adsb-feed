import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWindowedRate } from "../useWindowedRate";

describe("useWindowedRate", () => {
  it("returns 0 when counter is null", () => {
    const { result } = renderHook(() => useWindowedRate(null, 0, 5));
    expect(result.current).toBe(0);
  });

  it("returns fallback rate for the first snapshot (< 2 entries)", () => {
    const { result } = renderHook(() => useWindowedRate(100, 10, 5, 10));
    // Only 1 entry in buffer → falls back to provided fallbackRate
    expect(result.current).toBe(10);
  });

  it("returns 0 fallback when none provided and < 2 entries", () => {
    const { result } = renderHook(() => useWindowedRate(100, 10, 5));
    expect(result.current).toBe(0);
  });

  it("computes correct windowed rate from 2 snapshots", () => {
    const { result, rerender } = renderHook(
      ({ counter, elapsed, windowSecs }: { counter: number; elapsed: number; windowSecs: number }) =>
        useWindowedRate(counter, elapsed, windowSecs),
      { initialProps: { counter: 100, elapsed: 10, windowSecs: 5 } },
    );

    // First render: 1 entry → fallback (0)
    expect(result.current).toBe(0);

    // Second snapshot: 200 messages at 11 seconds
    rerender({ counter: 200, elapsed: 11, windowSecs: 5 });
    // Rate = (200 - 100) / (11 - 10) = 100 msg/s
    expect(result.current).toBe(100);
  });

  it("computes rate over multiple snapshots within the window", () => {
    const { result, rerender } = renderHook(
      ({ counter, elapsed, windowSecs }: { counter: number; elapsed: number; windowSecs: number }) =>
        useWindowedRate(counter, elapsed, windowSecs),
      { initialProps: { counter: 0, elapsed: 0, windowSecs: 5 } },
    );

    // Feed 5 snapshots: 0,1,2,3,4 seconds with 10 msgs/s
    for (let i = 1; i <= 4; i++) {
      rerender({ counter: i * 10, elapsed: i, windowSecs: 5 });
    }

    // Rate = (40 - 0) / (4 - 0) = 10 msg/s
    expect(result.current).toBe(10);
  });

  it("trims old entries outside the window", () => {
    const { result, rerender } = renderHook(
      ({ counter, elapsed, windowSecs }: { counter: number; elapsed: number; windowSecs: number }) =>
        useWindowedRate(counter, elapsed, windowSecs),
      { initialProps: { counter: 0, elapsed: 0, windowSecs: 3 } },
    );

    // Seconds 1..5 with 10 msg/s each
    for (let i = 1; i <= 5; i++) {
      rerender({ counter: i * 10, elapsed: i, windowSecs: 3 });
    }

    // Window is 3s, so oldest retained entry should be at elapsed_secs=2 (5-3=2)
    // Rate = (50 - 20) / (5 - 2) = 10 msg/s
    expect(result.current).toBe(10);
  });

  it("reacts to burst: rate increases when messages spike", () => {
    const { result, rerender } = renderHook(
      ({ counter, elapsed, windowSecs }: { counter: number; elapsed: number; windowSecs: number }) =>
        useWindowedRate(counter, elapsed, windowSecs),
      { initialProps: { counter: 0, elapsed: 0, windowSecs: 5 } },
    );

    // Steady 10 msg/s for 3 seconds
    rerender({ counter: 10, elapsed: 1, windowSecs: 5 });
    rerender({ counter: 20, elapsed: 2, windowSecs: 5 });
    rerender({ counter: 30, elapsed: 3, windowSecs: 5 });

    // Burst: 200 messages in 1 second
    rerender({ counter: 230, elapsed: 4, windowSecs: 5 });

    // Rate = (230 - 0) / (4 - 0) = 57.5 msg/s
    expect(result.current).toBeCloseTo(57.5);
  });

  it("handles window size change", () => {
    const { result, rerender } = renderHook(
      ({ counter, elapsed, windowSecs }: { counter: number; elapsed: number; windowSecs: number }) =>
        useWindowedRate(counter, elapsed, windowSecs),
      { initialProps: { counter: 0, elapsed: 0, windowSecs: 10 } },
    );

    // Feed snapshots at 1s intervals, 10 msg/s each
    for (let i = 1; i <= 6; i++) {
      rerender({ counter: i * 10, elapsed: i, windowSecs: 10 });
    }

    // All within 10s window: rate = (60-0)/(6-0) = 10
    expect(result.current).toBe(10);

    // Shrink window to 3s — old entries should be trimmed on next update
    rerender({ counter: 70, elapsed: 7, windowSecs: 3 });
    // Window 3s from elapsed 7: oldest kept is at 4
    // Rate = (70 - 40) / (7 - 4) = 10
    expect(result.current).toBe(10);
  });

  it("returns 0 for null counter even after previous snapshots", () => {
    const { result, rerender } = renderHook(
      ({ counter, elapsed, windowSecs }: { counter: number | null; elapsed: number; windowSecs: number }) =>
        useWindowedRate(counter, elapsed, windowSecs),
      { initialProps: { counter: 100 as number | null, elapsed: 10, windowSecs: 5 } },
    );

    expect(result.current).toBe(0); // only 1 entry → fallback 0

    rerender({ counter: null, elapsed: 10, windowSecs: 5 });
    expect(result.current).toBe(0);
  });
});

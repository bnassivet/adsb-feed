import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWindowedRate } from "../useWindowedRate";
import type { MetricsSnapshot } from "@/lib/types";

function makeSnapshot(messages_sent: number, elapsed_secs: number): MetricsSnapshot {
  return {
    messages_sent,
    errors: 0,
    bytes_received: 0,
    bytes_sent: 0,
    retry_queue_size: 0,
    elapsed_secs,
    throughput_msg_per_sec: elapsed_secs > 0 ? messages_sent / elapsed_secs : 0,
  };
}

describe("useWindowedRate", () => {
  it("returns 0 when no snapshots have been provided", () => {
    const { result } = renderHook(() => useWindowedRate(null, 5));
    expect(result.current).toBe(0);
  });

  it("returns cumulative throughput for the first snapshot (< 2 entries)", () => {
    const snap = makeSnapshot(100, 10);
    const { result } = renderHook(() => useWindowedRate(snap, 5));
    // Only 1 entry in buffer → falls back to cumulative
    expect(result.current).toBe(10); // 100/10
  });

  it("computes correct windowed rate from 2 snapshots", () => {
    const { result, rerender } = renderHook(
      ({ snap, windowSecs }: { snap: MetricsSnapshot; windowSecs: number }) =>
        useWindowedRate(snap, windowSecs),
      { initialProps: { snap: makeSnapshot(100, 10), windowSecs: 5 } },
    );

    // First render: 1 entry → cumulative fallback
    expect(result.current).toBe(10);

    // Second snapshot: 200 messages at 11 seconds
    rerender({ snap: makeSnapshot(200, 11), windowSecs: 5 });
    // Rate = (200 - 100) / (11 - 10) = 100 msg/s
    expect(result.current).toBe(100);
  });

  it("computes rate over multiple snapshots within the window", () => {
    const { result, rerender } = renderHook(
      ({ snap, windowSecs }: { snap: MetricsSnapshot; windowSecs: number }) =>
        useWindowedRate(snap, windowSecs),
      { initialProps: { snap: makeSnapshot(0, 0), windowSecs: 5 } },
    );

    // Feed 5 snapshots: 0,1,2,3,4 seconds with 10 msgs/s
    for (let i = 1; i <= 4; i++) {
      rerender({ snap: makeSnapshot(i * 10, i), windowSecs: 5 });
    }

    // Rate = (40 - 0) / (4 - 0) = 10 msg/s
    expect(result.current).toBe(10);
  });

  it("trims old entries outside the window", () => {
    const { result, rerender } = renderHook(
      ({ snap, windowSecs }: { snap: MetricsSnapshot; windowSecs: number }) =>
        useWindowedRate(snap, windowSecs),
      { initialProps: { snap: makeSnapshot(0, 0), windowSecs: 3 } },
    );

    // Seconds 1..5 with 10 msg/s each
    for (let i = 1; i <= 5; i++) {
      rerender({ snap: makeSnapshot(i * 10, i), windowSecs: 3 });
    }

    // Window is 3s, so oldest retained entry should be at elapsed_secs=2 (5-3=2)
    // Rate = (50 - 20) / (5 - 2) = 10 msg/s
    expect(result.current).toBe(10);
  });

  it("reacts to burst: rate increases when messages spike", () => {
    const { result, rerender } = renderHook(
      ({ snap, windowSecs }: { snap: MetricsSnapshot; windowSecs: number }) =>
        useWindowedRate(snap, windowSecs),
      { initialProps: { snap: makeSnapshot(0, 0), windowSecs: 5 } },
    );

    // Steady 10 msg/s for 3 seconds
    rerender({ snap: makeSnapshot(10, 1), windowSecs: 5 });
    rerender({ snap: makeSnapshot(20, 2), windowSecs: 5 });
    rerender({ snap: makeSnapshot(30, 3), windowSecs: 5 });

    // Burst: 200 messages in 1 second
    rerender({ snap: makeSnapshot(230, 4), windowSecs: 5 });

    // Rate = (230 - 0) / (4 - 0) = 57.5 msg/s
    expect(result.current).toBeCloseTo(57.5);
  });

  it("handles window size change", () => {
    const { result, rerender } = renderHook(
      ({ snap, windowSecs }: { snap: MetricsSnapshot; windowSecs: number }) =>
        useWindowedRate(snap, windowSecs),
      { initialProps: { snap: makeSnapshot(0, 0), windowSecs: 10 } },
    );

    // Feed snapshots at 1s intervals, 10 msg/s each
    for (let i = 1; i <= 6; i++) {
      rerender({ snap: makeSnapshot(i * 10, i), windowSecs: 10 });
    }

    // All within 10s window: rate = (60-0)/(6-0) = 10
    expect(result.current).toBe(10);

    // Shrink window to 3s — old entries should be trimmed on next update
    rerender({ snap: makeSnapshot(70, 7), windowSecs: 3 });
    // Window 3s from elapsed 7: oldest kept is at 4
    // Rate = (70 - 40) / (7 - 4) = 10
    expect(result.current).toBe(10);
  });

  it("returns 0 for null metrics even after previous snapshots", () => {
    const { result, rerender } = renderHook(
      ({ snap, windowSecs }: { snap: MetricsSnapshot | null; windowSecs: number }) =>
        useWindowedRate(snap, windowSecs),
      { initialProps: { snap: makeSnapshot(100, 10) as MetricsSnapshot | null, windowSecs: 5 } },
    );

    expect(result.current).toBe(10); // cumulative fallback

    rerender({ snap: null, windowSecs: 5 });
    expect(result.current).toBe(0);
  });
});

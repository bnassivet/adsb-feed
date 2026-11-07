import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { emitMockEvent } from "@/test/mocks/tauri";
import { useMetrics } from "../useMetrics";
import type { MetricsSnapshot } from "@/lib/types";

/**
 * An MQTT session's base counters are a zeroed handle (`messages_sent` stays 0);
 * only the ingest-pipeline counters move. That is the case hits/s used to miss.
 */
function snapshot(elapsed: number, messages: number, positions: number): MetricsSnapshot {
  return {
    messages_sent: 0,
    messages_received: 0,
    messages_parsed: messages,
    positions_parsed: positions,
    errors: 0,
    bytes_received: 0,
    bytes_sent: 0,
    retry_queue_size: 0,
    reconnection_attempts: 0,
    elapsed_secs: elapsed,
    throughput_msg_per_sec: 0,
  };
}

async function renderWithSnapshots(snaps: MetricsSnapshot[]) {
  const { result } = renderHook(() => useMetrics());
  // listen() resolves asynchronously; let the subscription register first.
  await act(async () => {});
  for (const snap of snaps) {
    act(() => {
      emitMockEvent("adsb:metrics", snap);
    });
  }
  return result;
}

describe("useMetrics", () => {
  it("derives hits/s from every parsed MSG line, whatever its type", async () => {
    // 100 MSG lines/s, 20 of them positions.
    const result = await renderWithSnapshots([
      snapshot(1, 100, 20),
      snapshot(2, 200, 40),
      snapshot(3, 300, 60),
    ]);
    expect(result.current.hits_per_sec).toBeCloseTo(100);
  });

  it("derives pos/s from position messages only", async () => {
    const result = await renderWithSnapshots([
      snapshot(1, 100, 20),
      snapshot(2, 200, 40),
      snapshot(3, 300, 60),
    ]);
    expect(result.current.throughput_msg_per_sec).toBeCloseTo(20);
  });

  it("reads hits/s above pos/s when non-position messages arrive", async () => {
    const result = await renderWithSnapshots([snapshot(1, 50, 10), snapshot(2, 150, 30)]);
    expect(result.current.hits_per_sec).toBeGreaterThan(result.current.throughput_msg_per_sec);
  });
});

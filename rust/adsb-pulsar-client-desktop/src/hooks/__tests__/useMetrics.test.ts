import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { emitMockEvent } from "@/test/mocks/tauri";
import { useMetrics } from "../useMetrics";
import type { MetricsSnapshot } from "@/lib/types";

/**
 * An MQTT session's base counters are a zeroed handle (`messages_sent` stays 0);
 * only the ingest-pipeline counters move. That is the case hits/s used to miss.
 */
function snapshot(
  elapsed: number,
  lines: number,
  messages: number,
  positions: number,
): MetricsSnapshot {
  return {
    messages_sent: 0,
    messages_received: 0,
    lines_received: lines,
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

// Per second: 150 lines received, 100 merged into aircraft, 20 with a position.
const STEADY = [snapshot(1, 150, 100, 20), snapshot(2, 300, 200, 40), snapshot(3, 450, 300, 60)];

describe("useMetrics", () => {
  it("derives hits/s from every received line", async () => {
    const result = await renderWithSnapshots(STEADY);
    expect(result.current.hits_per_sec).toBeCloseTo(150);
  });

  it("derives msgs/s from messages merged into aircraft", async () => {
    const result = await renderWithSnapshots(STEADY);
    expect(result.current.throughput_msg_per_sec).toBeCloseTo(100);
  });

  it("derives pos/s from position messages only", async () => {
    const result = await renderWithSnapshots(STEADY);
    expect(result.current.pos_per_sec).toBeCloseTo(20);
  });

  it("orders the rates hits/s >= msgs/s >= pos/s", async () => {
    const result = await renderWithSnapshots([snapshot(1, 60, 50, 10), snapshot(2, 180, 150, 30)]);
    const { hits_per_sec, throughput_msg_per_sec, pos_per_sec } = result.current;
    expect(hits_per_sec).toBeGreaterThan(throughput_msg_per_sec);
    expect(throughput_msg_per_sec).toBeGreaterThan(pos_per_sec);
  });
});

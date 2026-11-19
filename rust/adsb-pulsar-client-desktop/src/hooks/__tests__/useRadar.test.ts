import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import { useRadar, RADAR_REFRESH_MS } from "../useRadar";
import { getRadar } from "@/lib/commands";
import type { RadarSnapshot } from "@/lib/radar";

const strict = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);
const HERE = { lat: 47.2, lng: -1.6 };

function snap(over: Partial<RadarSnapshot> = {}): RadarSnapshot {
  return { pngBase64: "AAAA", bounds: [42, -9, 52, 6], validTimeMs: 1_800_000_000_000, accumulationMinutes: 5, origin: "download", error: null, scale: [], ...over };
}

describe("getRadar", () => {
  beforeEach(() => clearMockResponses());
  it("passes position, radius and force", async () => {
    let args: unknown;
    mockInvokeResponse("get_radar", (a: unknown) => ((args = a), snap()));
    await getRadar(47.2, -1.6, 300, false);
    expect(args).toEqual({ lat: 47.2, lng: -1.6, radiusNm: 300, force: false });
  });
});

describe("useRadar", () => {
  let calls: { force: boolean }[] = [];
  const respond = (s: RadarSnapshot | (() => Promise<never>)) =>
    mockInvokeResponse("get_radar", (a: { force: boolean }) => {
      calls.push(a);
      return typeof s === "function" ? s() : s;
    });
  beforeEach(() => {
    clearMockResponses();
    calls = [];
  });
  afterEach(() => vi.useRealTimers());

  it("does nothing while off", () => {
    respond(snap());
    const { result } = renderHook(() => useRadar(false, HERE));
    expect(result.current.snapshot).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("loads once when switched on, under StrictMode too", async () => {
    respond(snap());
    const { result } = renderHook(() => useRadar(true, HERE), { wrapper: strict });
    await waitFor(() => expect(result.current.snapshot?.pngBase64).toBe("AAAA"));
    expect(calls).toHaveLength(1);
  });

  it("polls while on and stops when off", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    respond(snap());
    const { result, rerender } = renderHook(({ on }) => useRadar(on, HERE), { initialProps: { on: true } });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    await act(async () => vi.advanceTimersByTime(RADAR_REFRESH_MS));
    expect(calls).toHaveLength(2);
    rerender({ on: false });
    expect(result.current.snapshot).toBeNull();
    await act(async () => vi.advanceTimersByTime(RADAR_REFRESH_MS * 2));
    expect(calls).toHaveLength(2);
  });

  it("forces on reload, needs a receiver, and reports errors", async () => {
    respond(snap({ origin: "stale-cache", error: "HTTP 503" }));
    const { result } = renderHook(() => useRadar(true, HERE));
    await waitFor(() => expect(result.current.error).toBe("HTTP 503"));
    expect(result.current.stale).toBe(true);
    await act(async () => result.current.reload());
    expect(calls.at(-1)?.force).toBe(true);
    const none = renderHook(() => useRadar(true, null));
    expect(none.result.current.error).toMatch(/receiver/i);
  });
});

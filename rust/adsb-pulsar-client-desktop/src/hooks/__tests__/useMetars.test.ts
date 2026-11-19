import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import { useMetars, METAR_REFRESH_MS } from "../useMetars";
import { getMetars } from "@/lib/commands";
import type { MetarSnapshot } from "@/lib/metar";

const strict = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);
const MTL = { lat: 45.47, lng: -73.74 };

function snapshot(over: Partial<MetarSnapshot> = {}): MetarSnapshot {
  return {
    items: [{ icaoId: "CYUL", lat: 45.468, lon: -73.742, obsTime: 1795053600, fltCat: "VFR", rawOb: "METAR CYUL ..." }],
    fetchedAtMs: 1795053700_000,
    origin: "download",
    error: null,
    ...over,
  };
}

describe("getMetars", () => {
  beforeEach(() => clearMockResponses());

  it("passes position, radius and force to get_metars", async () => {
    let args: unknown;
    mockInvokeResponse("get_metars", (a: unknown) => {
      args = a;
      return snapshot();
    });
    await getMetars(45.5, -73.6, 300, true);
    expect(args).toEqual({ lat: 45.5, lng: -73.6, radiusNm: 300, force: true });
  });
});

describe("useMetars", () => {
  let calls: { force: boolean }[] = [];
  const respond = (s: MetarSnapshot | (() => Promise<never>)) =>
    mockInvokeResponse("get_metars", (a: { force: boolean }) => {
      calls.push(a);
      return typeof s === "function" ? s() : s;
    });

  beforeEach(() => {
    clearMockResponses();
    calls = [];
  });
  afterEach(() => vi.useRealTimers());

  it("does nothing while off", () => {
    respond(snapshot());
    const { result } = renderHook(() => useMetars(false, MTL));
    expect(result.current.metars).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("loads once when switched on, under StrictMode too", async () => {
    respond(snapshot());
    const { result } = renderHook(() => useMetars(true, MTL), { wrapper: strict });
    await waitFor(() => expect(result.current.metars).toHaveLength(1));
    expect(calls).toHaveLength(1);
    expect(calls[0].force).toBe(false);
    expect(result.current.fetchedAtMs).toBe(1795053700_000);
  });

  it("needs a receiver position", () => {
    respond(snapshot());
    const { result } = renderHook(() => useMetars(true, null));
    expect(result.current.error).toMatch(/receiver/i);
    expect(result.current.loading).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("refreshes on a timer while on, and stops when off", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    respond(snapshot());
    const { result, rerender } = renderHook(({ on }) => useMetars(on, MTL), { initialProps: { on: true } });
    await waitFor(() => expect(result.current.metars).toHaveLength(1));
    await act(async () => vi.advanceTimersByTime(METAR_REFRESH_MS));
    expect(calls).toHaveLength(2);
    expect(calls[1].force).toBe(false);
    rerender({ on: false });
    await act(async () => vi.advanceTimersByTime(METAR_REFRESH_MS * 2));
    expect(calls).toHaveLength(2);
  });

  it("forces a refresh on reload", async () => {
    respond(snapshot());
    const { result } = renderHook(() => useMetars(true, MTL));
    await waitFor(() => expect(result.current.metars).toHaveLength(1));
    await act(async () => result.current.reload());
    expect(calls.at(-1)?.force).toBe(true);
  });

  it("keeps the last reports when a refresh fails, and shows the error", async () => {
    respond(snapshot({ origin: "stale-cache", error: "HTTP 503" }));
    const { result } = renderHook(() => useMetars(true, MTL));
    await waitFor(() => expect(result.current.metars).toHaveLength(1));
    expect(result.current.stale).toBe(true);
    expect(result.current.error).toBe("HTTP 503");
  });

  it("reports a failed command", async () => {
    respond(() => Promise.reject("Invalid position"));
    const { result } = renderHook(() => useMetars(true, MTL));
    await waitFor(() => expect(result.current.error).toBe("Invalid position"));
  });
});

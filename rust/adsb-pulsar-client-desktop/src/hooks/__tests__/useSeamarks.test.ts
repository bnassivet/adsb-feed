import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import { useSeamarks } from "../useSeamarks";
import { getSeamarks } from "@/lib/commands";
import type { SeamarkSnapshot } from "@/lib/seamark";

const strict = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);
const VIEW = "N46W006";
const OTHER = "N48W006";
const snap = (n: number): SeamarkSnapshot => ({
  items: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, lat: 47, lon: -5, tags: { "seamark:type": "rock" } })),
  stale: false,
  error: null,
});

describe("getSeamarks", () => {
  beforeEach(() => clearMockResponses());
  it("passes the view", async () => {
    let args: unknown;
    mockInvokeResponse("get_seamarks", (a: unknown) => {
      args = a;
      return snap(0);
    });
    await getSeamarks(47, -5, 47.5, -4.5);
    expect(args).toEqual({ south: 47, west: -5, north: 47.5, east: -4.5 });
  });
});

describe("useSeamarks", () => {
  let calls: { south: number }[] = [];
  beforeEach(() => {
    clearMockResponses();
    calls = [];
  });

  it("does nothing while off or without a view", () => {
    mockInvokeResponse("get_seamarks", (a: { south: number }) => (calls.push(a), snap(1)));
    renderHook(() => useSeamarks(false, VIEW));
    const { result } = renderHook(() => useSeamarks(true, null));
    expect(result.current.items).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("loads once per set of cells, under StrictMode too", async () => {
    mockInvokeResponse("get_seamarks", (a: { south: number }) => (calls.push(a), snap(3)));
    const { result, rerender } = renderHook(({ v }: { v: string }) => useSeamarks(true, v), { wrapper: strict, initialProps: { v: VIEW } });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    expect(result.current.loading).toBe(false);
    rerender({ v: VIEW });
    expect(calls).toHaveLength(1);
    expect(calls[0].south).toBeGreaterThan(46);
    rerender({ v: OTHER });
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it("ignores an answer for cells the view has left", async () => {
    let release: (s: SeamarkSnapshot) => void = () => {};
    mockInvokeResponse("get_seamarks", (a: { south: number }) =>
      a.south < 48 ? new Promise<SeamarkSnapshot>((r) => (release = r)) : snap(2));
    const { result, rerender } = renderHook(({ v }: { v: string }) => useSeamarks(true, v), { initialProps: { v: VIEW } });
    rerender({ v: OTHER });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    release(snap(9));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.items).toHaveLength(2);
  });

  it("reports errors", async () => {
    mockInvokeResponse("get_seamarks", () => Promise.reject("Zoom in to describe seamarks"));
    const { result } = renderHook(() => useSeamarks(true, VIEW));
    await waitFor(() => expect(result.current.error).toBe("Zoom in to describe seamarks"));
  });
});

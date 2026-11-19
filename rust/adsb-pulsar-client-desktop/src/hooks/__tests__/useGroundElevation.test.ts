import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import { useGroundElevation } from "../useGroundElevation";
import { getGroundElevation, whatIsHere } from "@/lib/commands";

const strict = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);

describe("terrain commands", () => {
  beforeEach(() => clearMockResponses());
  it("pass the point", async () => {
    const seen: unknown[] = [];
    mockInvokeResponse("get_ground_elevation", (a: unknown) => (seen.push(a), 120));
    mockInvokeResponse("what_is_here", (a: unknown) => (seen.push(a), { elevationM: 1, elevationError: null, depth: null, depthError: null }));
    expect(await getGroundElevation(47, -1.5)).toBe(120);
    await whatIsHere(47, -1.5);
    expect(seen).toEqual([{ lat: 47, lng: -1.5 }, { lat: 47, lng: -1.5 }]);
  });
});

describe("useGroundElevation", () => {
  let calls: { lat: number }[] = [];
  beforeEach(() => {
    clearMockResponses();
    calls = [];
  });

  it("asks nothing without a point", () => {
    mockInvokeResponse("get_ground_elevation", (a: { lat: number }) => (calls.push(a), 10));
    const { result } = renderHook(() => useGroundElevation(null));
    expect(result.current.groundM).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("asks once per ~200 m, under StrictMode too", async () => {
    mockInvokeResponse("get_ground_elevation", (a: { lat: number }) => (calls.push(a), 312));
    const { result, rerender } = renderHook(({ p }) => useGroundElevation(p), {
      wrapper: strict,
      initialProps: { p: { lat: 47.2001, lng: -1.5 } as { lat: number; lng: number } | null },
    });
    await waitFor(() => expect(result.current.groundM).toBe(312));
    rerender({ p: { lat: 47.2005, lng: -1.5 } });
    expect(calls).toHaveLength(1);
    rerender({ p: { lat: 47.21, lng: -1.5 } });
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it("keeps the last height while the next one loads, and drops it with no point", async () => {
    let n = 0;
    mockInvokeResponse("get_ground_elevation", () => (n++ === 0 ? 100 : new Promise(() => {})));
    const { result, rerender } = renderHook(({ p }) => useGroundElevation(p), {
      initialProps: { p: { lat: 47.2, lng: -1.5 } as { lat: number; lng: number } | null },
    });
    await waitFor(() => expect(result.current.groundM).toBe(100));
    rerender({ p: { lat: 47.3, lng: -1.5 } });
    expect(result.current.groundM).toBe(100);
    rerender({ p: null });
    expect(result.current.groundM).toBeNull();
  });

  it("reports errors", async () => {
    mockInvokeResponse("get_ground_elevation", () => Promise.reject("Terrain tile: HTTP 503"));
    const { result } = renderHook(() => useGroundElevation({ lat: 47, lng: -1.5 }));
    await waitFor(() => expect(result.current.error).toBe("Terrain tile: HTTP 503"));
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import { useAirspaces } from "../useAirspaces";
import { getAirspaces } from "@/lib/commands";
import type { CountryAirspaces } from "@/lib/airspace";

const strict = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);

function tma(id: string, lng: number, lat: number) {
  const h = 0.3;
  return {
    _id: id,
    name: id,
    type: 7,
    icaoClass: 2,
    geometry: { type: "Polygon", coordinates: [[[lng - h, lat - h], [lng + h, lat - h], [lng + h, lat + h], [lng - h, lat + h], [lng - h, lat - h]]] },
    lowerLimit: { value: 2500, unit: 1, referenceDatum: 1 },
    upperLimit: { value: 180, unit: 6, referenceDatum: 2 },
  };
}

const RESPONSE: CountryAirspaces[] = [
  {
    country: "CA",
    cycle: { ident: "2611", effective: "2026-10-29", expires: "2026-11-26" },
    expired: false,
    origin: "download",
    items: [tma("near", -73.6, 45.5), tma("far", -120, 50)],
    error: null,
  },
];

describe("getAirspaces", () => {
  beforeEach(() => clearMockResponses());

  it("invokes get_airspaces", async () => {
    mockInvokeResponse("get_airspaces", RESPONSE);
    expect(await getAirspaces()).toEqual(RESPONSE);
  });
});

describe("useAirspaces", () => {
  let calls = 0;
  /** The response, counting how many times Rust is asked. */
  const counted = (r: unknown) => () => {
    calls++;
    return r;
  };

  beforeEach(() => {
    clearMockResponses();
    calls = 0;
  });

  it("loads nothing while the layer is off", () => {
    mockInvokeResponse("get_airspaces", counted(RESPONSE));
    const { result } = renderHook(() => useAirspaces(false, null));
    expect(result.current.airspaces).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(calls).toBe(0);
  });

  it("loads once when switched on, under StrictMode too", async () => {
    mockInvokeResponse("get_airspaces", counted(RESPONSE));
    const { result } = renderHook(() => useAirspaces(true, null), { wrapper: strict });
    await waitFor(() => expect(result.current.airspaces).toHaveLength(2));
    expect(calls).toBe(1);
    expect(result.current.status).toEqual({ cycles: ["2611"], expired: false, errors: [] });
  });

  it("keeps what is near the receiver", async () => {
    mockInvokeResponse("get_airspaces", RESPONSE);
    const { result } = renderHook(() => useAirspaces(true, { lat: 45.5, lng: -73.6 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.airspaces.map((a) => a.name)).toEqual(["near"]);
  });

  it("does not reload when switched off and on again", async () => {
    mockInvokeResponse("get_airspaces", counted(RESPONSE));
    const { result, rerender } = renderHook(({ on }) => useAirspaces(on, null), { initialProps: { on: true } });
    await waitFor(() => expect(result.current.airspaces).toHaveLength(2));
    rerender({ on: false });
    expect(result.current.airspaces).toEqual([]);
    rerender({ on: true });
    expect(result.current.airspaces).toHaveLength(2);
    expect(calls).toBe(1);
  });

  it("reports a failed command and retries on reload", async () => {
    mockInvokeResponse("get_airspaces", () => Promise.reject("No app data directory"));
    const { result } = renderHook(() => useAirspaces(true, null));
    await waitFor(() => expect(result.current.error).toBe("No app data directory"));
    mockInvokeResponse("get_airspaces", RESPONSE);
    await act(async () => result.current.reload());
    await waitFor(() => expect(result.current.airspaces).toHaveLength(2));
    expect(result.current.error).toBeNull();
  });
});

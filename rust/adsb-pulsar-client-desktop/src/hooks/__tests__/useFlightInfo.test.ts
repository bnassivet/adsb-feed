import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import { useFlightInfo } from "../useFlightInfo";
import type { FlightInfo } from "@/lib/types";

const strict = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);

function info(hex: string, over: Partial<FlightInfo> = {}): FlightInfo {
  return {
    hex_ident: hex, callsign: "DLH400", source: "web", stale: false, error: null, simulated: false, route: null,
    aircraft: {
      hex_ident: hex, found: true, icao_type: "A319", type_name: "A319 112", manufacturer: "Airbus", registration: "D-AIBD",
      owner: "Lufthansa", owner_country: "Germany", photo_url: "https://image.airport-data.com/a.jpg",
      photo_thumb_url: "https://airport-data.com/t.jpg", fetched_at_ms: 0,
    },
    ...over,
  };
}

type Sel = { hex_ident: string; callsign: string | null } | null;

describe("useFlightInfo", () => {
  let asked: unknown[] = [];
  beforeEach(() => {
    clearMockResponses();
    asked = [];
    mockInvokeResponse("get_flight_info", (a: { hexIdent: string }) => (asked.push(a), info(a.hexIdent)));
    mockInvokeResponse("get_aircraft_photo", () => "data:image/jpeg;base64,AAA");
  });

  it("asks nothing until requested, under StrictMode too", async () => {
    const { result } = renderHook(() => useFlightInfo({ hex_ident: "3C6444", callsign: "DLH400" }, false), { wrapper: strict });
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toHaveLength(0);
    expect(result.current.status).toBe("idle");
  });

  it("loads info then photo on request", async () => {
    const { result } = renderHook(() => useFlightInfo({ hex_ident: "3C6444", callsign: "DLH400" }, false), { wrapper: strict });
    act(() => result.current.request());
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(asked).toEqual([{ hexIdent: "3C6444", callsign: "DLH400" }]);
    expect(result.current.info?.aircraft?.registration).toBe("D-AIBD");
    await waitFor(() => expect(result.current.photo).toBe("data:image/jpeg;base64,AAA"));
  });

  it("does not ask for a photo the aircraft has no link for", async () => {
    let photoAsks = 0;
    mockInvokeResponse("get_flight_info", (a: { hexIdent: string }) => info(a.hexIdent, { aircraft: null }));
    mockInvokeResponse("get_aircraft_photo", () => (photoAsks++, null));
    const { result } = renderHook(() => useFlightInfo({ hex_ident: "3C6444", callsign: null }, false));
    act(() => result.current.request());
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(photoAsks).toBe(0);
  });

  it("resets to idle for another aircraft and drops the late answer", async () => {
    let resolve: (v: FlightInfo) => void = () => {};
    mockInvokeResponse("get_flight_info", () => new Promise<FlightInfo>((r) => (resolve = r)));
    const { result, rerender } = renderHook(({ s }) => useFlightInfo(s, false), {
      initialProps: { s: { hex_ident: "3C6444", callsign: "DLH400" } as Sel },
    });
    act(() => result.current.request());
    rerender({ s: { hex_ident: "39BDA4", callsign: "AFR006" } });
    expect(result.current.status).toBe("idle");
    await act(async () => resolve(info("3C6444")));
    expect(result.current.status).toBe("idle");
    expect(result.current.info).toBeNull();
  });

  it("resets when the callsign of the same aircraft changes", async () => {
    const { result, rerender } = renderHook(({ s }) => useFlightInfo(s, false), {
      initialProps: { s: { hex_ident: "3C6444", callsign: null } as Sel },
    });
    act(() => result.current.request());
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    rerender({ s: { hex_ident: "3C6444", callsign: "DLH400" } });
    expect(result.current.status).toBe("idle");
  });

  it("never asks for a simulated aircraft", async () => {
    const { result } = renderHook(() => useFlightInfo({ hex_ident: "ABC123", callsign: "SIM1" }, true));
    act(() => result.current.request());
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toHaveLength(0);
    expect(result.current.status).toBe("idle");
  });

  it("reports a failed command as an error", async () => {
    mockInvokeResponse("get_flight_info", () => Promise.reject(new Error("boom")));
    const { result } = renderHook(() => useFlightInfo({ hex_ident: "3C6444", callsign: null }, false));
    act(() => result.current.request());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("boom");
  });
});

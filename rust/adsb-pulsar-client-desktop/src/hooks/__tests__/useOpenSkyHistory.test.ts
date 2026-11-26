import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { clearMockResponses, mockInvokeResponse } from "@/test/mocks/tauri";
import { useOpenSkyHistory } from "../useOpenSkyHistory";
import type { AircraftTrack } from "@/lib/types";

const HOUR = 3_600_000;
const NOW = Date.now();

function flight(id: string): AircraftTrack {
  return {
    hex_ident: "3C6444",
    callsign: "DLH9LF",
    altitude: null,
    ground_speed: null,
    track: null,
    latitude: 47,
    longitude: -2,
    vertical_rate: null,
    squawk: null,
    is_on_ground: null,
    timestamp: "",
    positions: [[47, -2, null]],
    first_seen: NOW - 2 * HOUR,
    last_seen: NOW - HOUR,
    message_count: 1,
    track_id: id,
  };
}

const TRACK = {
  icao24: "3c6444",
  callsign: "DLH9LF",
  start_time: Math.round((NOW - 3 * HOUR) / 1000),
  end_time: Math.round(NOW / 1000),
  path: [{ time: 1, latitude: 47, longitude: -2, on_ground: false }],
};

describe("useOpenSkyHistory", () => {
  afterEach(() => clearMockResponses());

  it("fetches a flight at its time and keeps it by Analysis track, not by hex", async () => {
    const calls: unknown[] = [];
    mockInvokeResponse("get_opensky_track", (args: unknown) => {
      calls.push(args);
      return { track: TRACK, stored: false };
    });
    const { result } = renderHook(() => useOpenSkyHistory(["F1", "F2"]));
    act(() => result.current.fetch(flight("F1")));
    expect(result.current.entries.get("F1")?.kind).toBe("loading");
    await waitFor(() => expect(result.current.entries.get("F1")?.kind).toBe("done"));
    expect(result.current.entries.has("F2")).toBe(false);
    expect(calls[0]).toEqual({ icao24: "3c6444", time: Math.round((NOW - 1.5 * HOUR) / 1000) });
    act(() => result.current.discard("F1"));
    expect(result.current.entries.size).toBe(0);
  });

  it("drops a flight's history when the track leaves Analysis", async () => {
    mockInvokeResponse("get_opensky_track", { track: TRACK, stored: false });
    const { result, rerender } = renderHook(({ keys }) => useOpenSkyHistory(keys), {
      initialProps: { keys: ["F1"] },
    });
    act(() => result.current.fetch(flight("F1")));
    await waitFor(() => expect(result.current.entries.get("F1")?.kind).toBe("done"));
    rerender({ keys: [] });
    expect(result.current.entries.size).toBe(0);
  });

  it("does not bring back a flight removed while its fetch was running", async () => {
    let resolve: (v: unknown) => void = () => {};
    mockInvokeResponse("get_opensky_track", () => new Promise((r) => (resolve = r)));
    const { result, rerender } = renderHook(({ keys }) => useOpenSkyHistory(keys), {
      initialProps: { keys: ["F1"] },
    });
    act(() => result.current.fetch(flight("F1")));
    rerender({ keys: [] });
    await act(async () => {
      resolve({ track: TRACK, stored: false });
      await Promise.resolve();
    });
    expect(result.current.entries.size).toBe(0);
  });
});

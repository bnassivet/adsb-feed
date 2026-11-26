import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { clearMockResponses, emitMockEvent, mockInvokeResponse as mockResponse } from "@/test/mocks/tauri";
import { useOpenSky, PRUNE_EVERY_MS } from "../useOpenSky";
import { useOpenSkyWatch, type OpenSkyWatchInputs } from "../useOpenSkyWatch";
import { WATCH_RENEW_MS, type OpenSkyStatus, type StatesMessage } from "@/lib/opensky";
import type { AircraftTrack } from "@/lib/types";

function poll(icao: string, fetched = Date.now()): StatesMessage {
  return {
    version: 1,
    fetched_ms: fetched,
    data_time: Math.floor(fetched / 1000),
    states: [
      {
        state: {
          icao24: icao,
          time_position: Math.floor(fetched / 1000),
          latitude: 47,
          longitude: -2,
          altitude_ft: 30000,
          on_ground: false,
        },
        matched: [{ kind: "area", id: "w" }],
      },
    ],
  };
}

function status(enabled: boolean): OpenSkyStatus {
  return {
    version: 1,
    enabled,
    authenticated: true,
    state: enabled ? "idle" : "disabled",
    watch: { icao24: 0, areas: 0, clients: 0 },
    cycle_cost: 0,
    credits: { daily_limit: 4000, states_used_24h: 12, tracks_used_24h: 0 },
    consecutive_failures: 0,
    updated_at_ms: 1,
  };
}

// Every mocked command records its call, so tests can assert what was sent.
let calls: [string, unknown][] = [];
function mockInvokeResponse(command: string, response: unknown) {
  mockResponse(command, (args: unknown) => {
    calls.push([command, args ?? undefined]);
    return typeof response === "function" ? (response as (a: unknown) => unknown)(args) : response;
  });
}
const invoked = () => calls.filter(([c]) => !c.startsWith("get_opensky_s"));

describe("useOpenSky", () => {
  beforeEach(() => {
    clearMockResponses();
    calls = [];
    mockInvokeResponse("get_opensky_service", { status: null, availability: null });
    mockInvokeResponse("get_opensky_states", null);
  });

  it("folds polls into tracks while the layer is on", async () => {
    const { result } = renderHook(() => useOpenSky(true));
    await waitFor(() => expect(calls.map(([c]) => c)).toContain("get_opensky_states"));
    act(() => emitMockEvent("adsb:opensky", poll("3c6444")));
    expect(result.current.external.get("3C6444")?.track_id).toBe("osky:3C6444");
  });

  it("ignores polls while the layer is off, and drops what it held when switched off", async () => {
    const { result, rerender } = renderHook(({ on }) => useOpenSky(on), { initialProps: { on: true } });
    act(() => emitMockEvent("adsb:opensky", poll("3c6444")));
    expect(result.current.external.size).toBe(1);
    rerender({ on: false });
    expect(result.current.external.size).toBe(0);
    // The event subscription was made on the first render: the switch must
    // still be honoured (a stale closure would accept this poll).
    act(() => emitMockEvent("adsb:opensky", poll("39de4f")));
    expect(result.current.external.size).toBe(0);
  });

  it("takes the service view from its event", () => {
    const { result } = renderHook(() => useOpenSky(true));
    act(() => emitMockEvent("adsb:opensky-service", { status: status(true), availability: "online" }));
    expect(result.current.service.status?.credits.states_used_24h).toBe(12);
    expect(result.current.service.availability).toBe("online");
  });

  it("stays pending on enable/disable until the status confirms it", async () => {
    mockInvokeResponse("set_opensky_enabled", undefined);
    const { result } = renderHook(() => useOpenSky(true));
    act(() => result.current.setServiceEnabled(false));
    expect(result.current.pendingEnabled).toBe(false);
    act(() => emitMockEvent("adsb:opensky-service", { status: status(false), availability: "online" }));
    expect(result.current.pendingEnabled).toBeNull();
  });

  it("backfills a track on demand, and says when OpenSky has none", async () => {
    mockInvokeResponse("get_opensky_track", (args: unknown) =>
      (args as { icao24: string }).icao24 === "3c6444"
        ? { track: { icao24: "3c6444", start_time: 1, end_time: 2, path: [] }, stored: false }
        : { track: null, stored: false },
    );
    const { result } = renderHook(() => useOpenSky(true));
    act(() => result.current.requestBackfill("3C6444"));
    expect(result.current.backfill.get("3C6444")?.kind).toBe("loading");
    await waitFor(() => expect(result.current.backfill.get("3C6444")?.kind).toBe("done"));
    act(() => result.current.requestBackfill("39DE4F"));
    await waitFor(() => expect(result.current.backfill.get("39DE4F")?.kind).toBe("none"));
    expect(calls).toContainEqual(["get_opensky_track", { icao24: "3c6444" }]);
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("drops a backfilled path with its aircraft's track, the layer still on", async () => {
      // Regression: the backfill used to stay drawn until the layer was switched off.
      mockInvokeResponse("get_opensky_track", {
        track: { icao24: "3c6444", start_time: 1, end_time: 2, path: [] },
        stored: false,
      });
      const { result } = renderHook(() => useOpenSky(true));
      act(() => emitMockEvent("adsb:opensky", poll("3c6444")));
      act(() => result.current.requestBackfill("3C6444"));
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.backfill.get("3C6444")?.kind).toBe("done");
      act(() => {
        vi.advanceTimersByTime(60_000 + PRUNE_EVERY_MS);
      });
      expect(result.current.external.size).toBe(0);
      expect(result.current.backfill.size).toBe(0);
    });

    it("drops an aircraft OpenSky keeps naming at a frozen position", () => {
      const { result } = renderHook(() => useOpenSky(true));
      const first = poll("3c6444");
      act(() => emitMockEvent("adsb:opensky", first));
      // Polls keep coming, every 10 s, always with the same old position.
      for (let i = 0; i < 15; i++) {
        act(() => {
          vi.advanceTimersByTime(10_000);
          emitMockEvent("adsb:opensky", { ...first, fetched_ms: Date.now() });
        });
      }
      expect(result.current.external.size).toBe(0);
    });

    it("drops aircraft the polls stopped mentioning", () => {
      const { result } = renderHook(() => useOpenSky(true));
      act(() => emitMockEvent("adsb:opensky", poll("3c6444")));
      act(() => {
        vi.advanceTimersByTime(60_000 + PRUNE_EVERY_MS);
      });
      expect(result.current.external.size).toBe(0);
    });
  });
});

describe("useOpenSkyWatch", () => {
  beforeEach(() => {
    clearMockResponses();
    calls = [];
    vi.useFakeTimers();
    mockInvokeResponse("set_opensky_watch", { icao24: 1, areas: 0, lease_seconds: 60, interval_seconds: 24 });
    mockInvokeResponse("clear_opensky_watch", undefined);
  });
  afterEach(() => vi.useRealTimers());

  const lost: AircraftTrack = {
    hex_ident: "3C6444",
    callsign: null,
    altitude: null,
    ground_speed: null,
    track: null,
    latitude: 47,
    longitude: -2,
    vertical_rate: null,
    squawk: null,
    is_on_ground: false,
    timestamp: "",
    positions: [],
    first_seen: 0,
    last_seen: 0,
    message_count: 1,
    last_position_ms: Date.now() - 60_000,
  };

  function inputs(over: Partial<OpenSkyWatchInputs> = {}): OpenSkyWatchInputs {
    return {
      active: true,
      followed: ["3C6444"],
      live: [{ ...lost, last_position_ms: Date.now() - 60_000 }],
      external: new Map(),
      receiver: { lat: 46.7, lng: -2.3 },
      mode: "gaps",
      areas: [],
      online: true,
      ...over,
    };
  }

  it("sends the list, then renews the lease every 20 s", async () => {
    const props = inputs();
    renderHook((p: OpenSkyWatchInputs) => useOpenSkyWatch(p), { initialProps: props });
    expect(invoked().filter(([c]) => c === "set_opensky_watch")).toEqual([
      ["set_opensky_watch", { icao24: ["3c6444"], areas: [] }],
    ]);
    await act(async () => {
      vi.advanceTimersByTime(WATCH_RENEW_MS);
    });
    expect(invoked().filter(([c]) => c === "set_opensky_watch")).toHaveLength(2);
  });

  it("sends nothing while nothing needs watching", () => {
    renderHook(() => useOpenSkyWatch(inputs({ followed: [] })));
    expect(invoked()).toEqual([]);
  });

  it("releases the lease when the layer is switched off", () => {
    const { rerender } = renderHook((p: OpenSkyWatchInputs) => useOpenSkyWatch(p), {
      initialProps: inputs(),
    });
    rerender(inputs({ active: false }));
    expect(invoked().map(([c]) => c)).toContain("clear_opensky_watch");
  });

  it("re-sends when the service comes back online", () => {
    const { rerender } = renderHook((p: OpenSkyWatchInputs) => useOpenSkyWatch(p), {
      initialProps: inputs({ online: false }),
    });
    expect(invoked()).toEqual([]);
    rerender(inputs({ online: true }));
    expect(invoked().filter(([c]) => c === "set_opensky_watch")).toHaveLength(1);
  });

  it("sends areas on their own", () => {
    const area = { id: "w", north: 48, south: 46, east: 0, west: -3 };
    renderHook(() => useOpenSkyWatch(inputs({ followed: [], areas: [area] })));
    expect(invoked()).toEqual([["set_opensky_watch", { icao24: [], areas: [area] }]]);
  });
});

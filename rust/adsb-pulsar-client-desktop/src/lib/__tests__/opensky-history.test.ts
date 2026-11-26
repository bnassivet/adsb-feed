import { describe, expect, it, vi } from "vitest";
import {
  HISTORY_MAX_AGE_MS,
  fetchFlightHistory,
  historyCost,
  historyGaps,
  historyMapData,
  historyQueryTimes,
  historyUnavailable,
  mergeTracks,
  openSkyHistoryScope,
  sameFlight,
} from "../opensky-history";
import type { OpenSkyTrack, OpenSkyWaypoint } from "../opensky";
import type { AircraftTrack } from "../types";

const HOUR = 3_600_000;
const NOW = 1_764_000_000_000;

function local(over: Partial<AircraftTrack> = {}): AircraftTrack {
  return {
    hex_ident: "3C6444",
    callsign: "DLH9LF ",
    altitude: null,
    ground_speed: null,
    track: null,
    latitude: 47,
    longitude: -1.5,
    vertical_rate: null,
    squawk: null,
    is_on_ground: null,
    timestamp: "",
    // A line due east along 47°N, 0.1° apart (about 4 NM).
    positions: [0, 1, 2, 3, 4, 5].map((i) => [47, -2 + i * 0.1, 30_000] as [number, number, number]),
    first_seen: NOW - 2 * HOUR,
    last_seen: NOW - HOUR,
    message_count: 100,
    track_id: "3C6444-1",
    ...over,
  };
}

function wp(time: number, lat: number, lng: number): OpenSkyWaypoint {
  return { time, latitude: lat, longitude: lng, on_ground: false };
}

function osky(over: Partial<OpenSkyTrack> = {}): OpenSkyTrack {
  return {
    icao24: "3c6444",
    callsign: "DLH9LF",
    start_time: (NOW - 3 * HOUR) / 1000,
    end_time: (NOW - HOUR / 2) / 1000,
    path: [],
    ...over,
  };
}

describe("historyQueryTimes", () => {
  it("asks at the middle of the local flight, then at its end", () => {
    const t = local();
    expect(historyQueryTimes(t)).toEqual([(NOW - 1.5 * HOUR) / 1000, (NOW - HOUR) / 1000]);
  });
});

describe("historyCost", () => {
  it("estimates 4 credits within a day, 30 beyond", () => {
    expect(historyCost(local(), NOW)).toBe(4);
    expect(historyCost(local({ first_seen: NOW - 50 * HOUR, last_seen: NOW - 49 * HOUR }), NOW)).toBe(30);
  });
});

describe("historyUnavailable", () => {
  const service = { reachable: true, authenticated: true };
  it("is null for a recent, real flight on an authenticated service", () => {
    expect(historyUnavailable(local(), NOW, service)).toBeNull();
  });
  it("names why a fetch is impossible", () => {
    expect(historyUnavailable(local(), NOW, { reachable: false, authenticated: false })).toMatch(/not reachable/);
    expect(historyUnavailable(local(), NOW, { reachable: true, authenticated: false })).toMatch(/credentials/);
    expect(historyUnavailable(local({ hex_ident: "SIM001" }), NOW, service)).toMatch(/ICAO/);
    const old = local({ first_seen: NOW - HISTORY_MAX_AGE_MS - 2 * HOUR, last_seen: NOW - HISTORY_MAX_AGE_MS - HOUR });
    expect(historyUnavailable(old, NOW, service)).toMatch(/30 days/);
  });
});

describe("sameFlight", () => {
  it("accepts an overlapping flight with the same callsign, case and padding aside", () => {
    expect(sameFlight(local(), osky({ callsign: "dlh9lf" }))).toEqual({ ok: true });
  });
  it("accepts when either side has no callsign", () => {
    expect(sameFlight(local({ callsign: null }), osky()).ok).toBe(true);
    expect(sameFlight(local(), osky({ callsign: null })).ok).toBe(true);
  });
  it("refuses another callsign", () => {
    const r = sameFlight(local(), osky({ callsign: "AFR123" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/AFR123/);
  });
  it("refuses a flight that does not overlap the local one", () => {
    const r = sameFlight(local(), osky({ start_time: (NOW - 10 * HOUR) / 1000, end_time: (NOW - 9 * HOUR) / 1000 }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/times/);
  });
});

describe("mergeTracks", () => {
  it("joins two tracks in time order, without duplicate waypoints", () => {
    const a = osky({ start_time: 10, end_time: 30, path: [wp(10, 47, -2), wp(30, 47, -1.8)] });
    const b = osky({ start_time: 30, end_time: 50, path: [wp(30, 47, -1.8), wp(50, 47, -1.6)] });
    const m = mergeTracks(b, a);
    expect(m.start_time).toBe(10);
    expect(m.end_time).toBe(50);
    expect(m.path.map((w) => w.time)).toEqual([10, 30, 50]);
  });
});

describe("historyGaps", () => {
  it("counts runs of OpenSky waypoints the receiver has nothing near, and their duration", () => {
    const path = [
      wp(0, 47, -2.0), // covered
      wp(60, 47.5, -1.9), // 30 NM north: a gap
      wp(180, 47.5, -1.7), // still the gap
      wp(240, 47, -1.6), // covered again
      wp(300, 48, -1.5), // a second gap, one waypoint
    ];
    const g = historyGaps(local(), osky({ path }));
    expect(g.count).toBe(2);
    // The first gap runs from the last covered waypoint to the next one: 0 → 240.
    expect(g.seconds).toBe(240 + 60);
    expect(g.segments).toHaveLength(2);
    expect(g.segments[0]).toEqual([[47, -2.0], [47.5, -1.9], [47.5, -1.7], [47, -1.6]]);
  });
  it("finds none on a fully covered flight", () => {
    const g = historyGaps(local(), osky({ path: [wp(0, 47, -2), wp(60, 47, -1.5)] }));
    expect(g).toEqual({ count: 0, seconds: 0, segments: [] });
  });
});

function reply(track: OpenSkyTrack | null, stored = false) {
  return { track, stored };
}

describe("fetchFlightHistory", () => {
  it("says when the flight came from storage, at no cost", async () => {
    const stored = await fetchFlightHistory(local(), vi.fn().mockResolvedValue(reply(osky(), true)));
    expect(stored.kind === "done" && stored.stored).toBe(true);
    const fetched = await fetchFlightHistory(local(), vi.fn().mockResolvedValue(reply(osky())));
    expect(fetched.kind === "done" && fetched.stored).toBe(false);
  });

  it("asks once when OpenSky's flight covers the local one", async () => {
    const fetch = vi.fn().mockResolvedValue(reply(osky({ path: [wp(1, 47, -2)] })));
    const r = await fetchFlightHistory(local(), fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("3c6444", (NOW - 1.5 * HOUR) / 1000);
    expect(r.kind).toBe("done");
  });

  it("asks a second time, at the end, when OpenSky's flight ends early, and merges", async () => {
    const first = osky({ end_time: (NOW - 1.25 * HOUR) / 1000, path: [wp(1, 47, -2)] });
    const second = osky({ start_time: (NOW - 1.2 * HOUR) / 1000, end_time: (NOW - 0.5 * HOUR) / 1000, path: [wp(2, 47, -1.5)] });
    const fetch = vi.fn().mockResolvedValueOnce(reply(first)).mockResolvedValueOnce(reply(second));
    const r = await fetchFlightHistory(local(), fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith("3c6444", (NOW - HOUR) / 1000);
    expect(r.kind === "done" && r.track.path).toHaveLength(2);
  });

  it("says when OpenSky has no flight, and when its flight is another one", async () => {
    expect(await fetchFlightHistory(local(), vi.fn().mockResolvedValue(reply(null)))).toEqual({ kind: "none" });
    const r = await fetchFlightHistory(local(), vi.fn().mockResolvedValue(reply(osky({ callsign: "AFR123" }))));
    expect(r.kind).toBe("mismatch");
  });

  it("turns a failure into an error entry", async () => {
    const r = await fetchFlightHistory(local(), vi.fn().mockRejectedValue("429 out of credits"));
    expect(r).toEqual({ kind: "error", message: "429 out of credits" });
  });
});

describe("historyMapData", () => {
  it("draws only fetched flights: their path, the gaps, and timed waypoints with their altitude", () => {
    const track = osky({ path: [{ ...wp(100, 47, -2), altitude_ft: 31_000 }, wp(200, 47.5, -1.9)] });
    const gaps = { count: 1, seconds: 100, segments: [[[47, -2], [47.5, -1.9]] as [number, number][]] };
    const out = historyMapData(
      new Map([
        ["F1", { kind: "done" as const, track, gaps, stored: false }],
        ["F2", { kind: "loading" as const }],
      ]),
    );
    expect(out).toEqual([
      {
        key: "F1",
        selectKey: "F1",
        hex: "3C6444",
        callsign: "DLH9LF",
        path: [[47, -2], [47.5, -1.9]],
        gaps: gaps.segments,
        waypoints: [
          { lat: 47, lng: -2, time: 100, altitude: 31_000 },
          { lat: 47.5, lng: -1.9, time: 200, altitude: null },
        ],
      },
    ]);
  });
});

describe("openSkyHistoryScope", () => {
  const a = local({ track_id: "A-1" });
  const h = local({ track_id: "H-1" });
  const d = local({ track_id: "D-1" });

  it("holds the fetched flights of Analysis, History and DB History together, whatever the mode", () => {
    for (const isLive of [true, false]) {
      expect(openSkyHistoryScope(isLive, [a], [h], [d]).held).toEqual(["A-1", "H-1", "D-1"]);
    }
  });

  it("offers a fetch on History and DB History tracks in Live mode, on Analysis tracks otherwise", () => {
    expect([...openSkyHistoryScope(true, [a], [h], [d]).selectable]).toEqual(["H-1", "D-1"]);
    expect([...openSkyHistoryScope(false, [a], [h], [d]).selectable]).toEqual(["A-1"]);
  });
});

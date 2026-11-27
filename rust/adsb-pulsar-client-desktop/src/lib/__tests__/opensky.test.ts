import { describe, expect, it } from "vitest";
import {
  areaCost,
  computeWatch,
  creditLevel,
  DISTANCE_CAP_NM,
  externalTrackPoints,
  openSkyTraceKey,
  openSkyTraceOwners,
  withoutHiddenTraces,
  EMPTY_OPENSKY_MAP,
  GAP_THRESHOLD_MS,
  isIcao24,
  LOSS_CAP_MS,
  mergeStates,
  openSkyMapData,
  MAX_WATCHED_AIRCRAFT,
  pruneExternal,
  pruneOpenSky,
  POSITION_MAX_AGE_MS,
  type BackfillEntry,
  selectionHex,
  staleAfterMs,
  visibleExternal,
  drawableExternal,
  openSkyFollowStatus,
  watchSignature,
  type ExternalTrack,
  type OpenSkyState,
  type StatesMessage,
} from "../opensky";
import type { AircraftTrack } from "../types";

const NOW = 1_764_000_000_000;
const RECEIVER = { lat: 46.7, lng: -2.3 };

function live(hex: string, lastPositionMs: number | undefined): AircraftTrack {
  return {
    hex_ident: hex,
    callsign: null,
    altitude: 30000,
    ground_speed: null,
    track: null,
    latitude: lastPositionMs === undefined ? null : 47,
    longitude: lastPositionMs === undefined ? null : -2,
    vertical_rate: null,
    squawk: null,
    is_on_ground: false,
    timestamp: "",
    positions: [],
    first_seen: 0,
    last_seen: NOW,
    message_count: 1,
    last_position_ms: lastPositionMs,
  };
}

function state(icao: string, over: Partial<OpenSkyState> = {}): OpenSkyState {
  return {
    icao24: icao,
    callsign: "DLH9LF",
    time_position: NOW / 1000 - 5,
    latitude: 47.1,
    longitude: -2.0,
    altitude_ft: 35000,
    on_ground: false,
    ...over,
  };
}

function poll(states: OpenSkyState[], fetched = NOW): StatesMessage {
  return {
    version: 1,
    fetched_ms: fetched,
    data_time: Math.floor(fetched / 1000),
    states: states.map((s) => ({ state: s, matched: [{ kind: "aircraft" }] })),
  };
}

function watch(
  followed: string[],
  liveTracks: AircraftTrack[],
  mode: "gaps" | "always" = "gaps",
  external = new Map<string, ExternalTrack>(),
) {
  return computeWatch({
    followed,
    live: new Map(liveTracks.map((t) => [t.hex_ident, t])),
    external,
    receiver: RECEIVER,
    mode,
    now: NOW,
  });
}

describe("selection keys", () => {
  it("accepts six hex digits only", () => {
    expect(isIcao24("3C6444")).toBe(true);
    expect(isIcao24("SIM-0001")).toBe(false);
    expect(isIcao24("AAA111-2")).toBe(false);
  });

  it("maps an OpenSky row's key back to its hex", () => {
    expect(selectionHex("osky:3c6444")).toBe("3C6444");
    expect(selectionHex("3c6444")).toBe("3C6444");
  });
});

describe("computeWatch", () => {
  it("does not ask for an aircraft the receiver still has, in gaps mode", () => {
    expect(watch(["3C6444"], [live("3C6444", NOW - 1_000)])).toEqual([]);
  });

  it("asks for it once its local position is older than the gap threshold", () => {
    expect(watch(["3C6444"], [live("3C6444", NOW - GAP_THRESHOLD_MS - 1)])).toEqual(["3c6444"]);
  });

  it("asks for it all the time in always mode", () => {
    expect(watch(["3C6444"], [live("3C6444", NOW - 1_000)], "always")).toEqual(["3c6444"]);
  });

  it("stops five minutes after the local loss", () => {
    expect(watch(["3C6444"], [live("3C6444", NOW - LOSS_CAP_MS - 1)])).toEqual([]);
    expect(watch(["3C6444"], [live("3C6444", NOW - LOSS_CAP_MS + 1_000)])).toEqual(["3c6444"]);
  });

  it("stops once OpenSky places it beyond 250 NM", () => {
    const far = mergeStates(new Map(), poll([state("3c6444", { latitude: 52, longitude: 3 })]), NOW);
    expect(watch(["3C6444"], [live("3C6444", NOW - 60_000)], "gaps", far)).toEqual([]);
    const near = mergeStates(new Map(), poll([state("3c6444")]), NOW);
    expect(watch(["3C6444"], [live("3C6444", NOW - 60_000)], "gaps", near)).toEqual(["3c6444"]);
    expect(DISTANCE_CAP_NM).toBe(250);
  });

  it("follows an aircraft picked from an OpenSky area, which has no local loss time", () => {
    expect(watch(["osky:39DE4F"], [])).toEqual(["39de4f"]);
  });

  it("never asks for simulated aircraft and caps the list", () => {
    expect(watch(["SIM-0001"], [])).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(6, "0"));
    expect(watch(many, [])).toHaveLength(MAX_WATCHED_AIRCRAFT);
  });

  it("leaves out an aircraft held back by the no-data backoff", () => {
    const out = computeWatch({
      followed: ["3C6444", "39DE4F"],
      live: new Map(),
      external: new Map(),
      receiver: RECEIVER,
      mode: "gaps",
      now: NOW,
      heldBack: new Set(["3C6444"]),
    });
    expect(out).toEqual(["39de4f"]);
  });

  it("is stable for the same inputs, whatever the order they were followed in", () => {
    expect(watch(["39DE4F", "3C6444"], [])).toEqual(watch(["3C6444", "39DE4F"], []));
  });
});

describe("mergeStates / pruneExternal", () => {
  it("builds a track keyed apart from the live one", () => {
    const m = mergeStates(new Map(), poll([state("3c6444")]), NOW);
    const t = m.get("3C6444")!;
    expect(t.track_id).toBe("osky:3C6444");
    expect(t.hex_ident).toBe("3C6444");
    expect(t.positions).toHaveLength(1);
    expect(t.source).toBe("opensky");
  });

  it("appends a position only when OpenSky's position time moves", () => {
    let m = mergeStates(new Map(), poll([state("3c6444")]), NOW);
    m = mergeStates(m, poll([state("3c6444")]), NOW + 10_000);
    expect(m.get("3C6444")!.positions).toHaveLength(1);
    m = mergeStates(m, poll([state("3c6444", { time_position: NOW / 1000 + 10, latitude: 47.2 })]), NOW + 20_000);
    expect(m.get("3C6444")!.positions).toHaveLength(2);
    expect(m.get("3C6444")!.first_seen).toBe(NOW);
  });

  it("drops aircraft no poll mentions any more", () => {
    const m = mergeStates(new Map(), poll([state("3c6444")]), NOW);
    expect(pruneExternal(m, NOW + 30_000, 60_000)).toBe(m);
    expect(pruneExternal(m, NOW + 61_000, 60_000).size).toBe(0);
  });

  it("keeps a stale window of at least a minute, longer for slow polls", () => {
    expect(staleAfterMs(null)).toBe(60_000);
    expect(staleAfterMs(96)).toBe(240_000);
  });
});

describe("visibleExternal", () => {
  const held = mergeStates(new Map(), poll([state("3c6444"), state("39de4f")]), NOW);

  it("hides what the receiver already shows, in gaps mode", () => {
    const shown = visibleExternal(held, new Map([["3C6444", live("3C6444", NOW - 1_000)]]), "gaps", NOW);
    expect(shown.map((t) => t.hex_ident)).toEqual(["39DE4F"]);
  });

  it("shows both in always mode", () => {
    const shown = visibleExternal(held, new Map([["3C6444", live("3C6444", NOW - 1_000)]]), "always", NOW);
    expect(shown).toHaveLength(2);
  });
  it("lists an aircraft OpenSky has no position for: the table shows it, the map does not", () => {
    const blind = mergeStates(
      new Map(),
      poll([state("3c6444", { time_position: null, latitude: null, longitude: null, last_contact: NOW / 1000 })]),
      NOW,
    );
    const listed = visibleExternal(blind, new Map([["3C6444", live("3C6444", undefined)]]), "gaps", NOW);
    expect(listed.map((t) => t.hex_ident)).toEqual(["3C6444"]);
    expect(drawableExternal(listed, NOW)).toEqual([]);
  });
});

describe("openSkyFollowStatus", () => {
  const base = { followed: true, watched: true, external: undefined, noData: undefined, now: NOW };
  const placed = mergeStates(new Map(), poll([state("3c6444")]), NOW).get("3C6444")!;
  const blind = mergeStates(
    new Map(),
    poll([state("3c6444", { time_position: null, latitude: null, longitude: null, last_contact: NOW / 1000 })]),
    NOW,
  ).get("3C6444")!;
  const noData = { sinceMs: NOW - 20_000, delayMs: 30_000, nextProbeMs: NOW + 10_000, stopped: false };

  it("is not-followed until the user follows it", () => {
    expect(openSkyFollowStatus({ ...base, followed: false })).toBe("not-followed");
  });
  it("is pending while followed but not asked for (the receiver still has it)", () => {
    expect(openSkyFollowStatus({ ...base, watched: false })).toBe("pending");
  });
  it("waits for OpenSky's first answer while asked for", () => {
    expect(openSkyFollowStatus(base)).toBe("waiting-answer");
  });
  it("says OpenSky has no data while backing off, and that it gave up once stopped", () => {
    expect(openSkyFollowStatus({ ...base, watched: false, noData })).toBe("no-data");
    expect(openSkyFollowStatus({ ...base, watched: true, noData })).toBe("no-data");
    expect(openSkyFollowStatus({ ...base, watched: false, noData: { ...noData, stopped: true } })).toBe("gave-up");
  });
  it("tells a known but unplaced aircraft from a placed one", () => {
    expect(openSkyFollowStatus({ ...base, external: blind })).toBe("no-position");
    expect(openSkyFollowStatus({ ...base, external: placed })).toBe("placed");
  });
  it("reports a placed aircraft even while not watched (the receiver has it again)", () => {
    expect(openSkyFollowStatus({ ...base, watched: false, external: placed })).toBe("placed");
  });
});

describe("credits", () => {
  it("charges an area as OpenSky does", () => {
    expect(areaCost({ id: "a", north: 48, south: 46, east: 0, west: -3 })).toBe(1);
    expect(areaCost({ id: "a", north: 50, south: 45, east: 5, west: -5 })).toBe(2);
  });

  it("colours the counter amber from 70 % and red from 90 % or when limited", () => {
    expect(creditLevel(100, 4000)).toBe("ok");
    expect(creditLevel(2800, 4000)).toBe("warn");
    expect(creditLevel(3600, 4000)).toBe("high");
    expect(creditLevel(0, 4000, true)).toBe("high");
  });

  it("gives effects a value signature", () => {
    const a = [{ id: "w", north: 1, south: 0, east: 1, west: 0 }];
    expect(watchSignature(["3c6444"], a)).toBe(watchSignature(["3c6444"], [...a]));
    expect(watchSignature(["3c6444"], a)).not.toBe(watchSignature([], a));
  });
});

describe("openSkyMapData", () => {
  const held = mergeStates(new Map(), poll([state("3c6444"), state("39de4f")]), NOW);
  const visible = [...held.values()];
  const localLost = live("3C6444", NOW - 60_000);

  it("joins a selected aircraft's last local position to OpenSky's first", () => {
    const d = openSkyMapData(visible, new Map([["3C6444", localLost]]), new Set(["3C6444"]), [], new Map());
    expect(d.connectors).toEqual([{ hex: "3C6444", from: [47, -2], to: [47.1, -2.0] }]);
  });

  it("draws no connector for an unselected or never-local aircraft", () => {
    const d = openSkyMapData(visible, new Map([["3C6444", localLost]]), new Set(["39DE4F"]), [], new Map());
    expect(d.connectors).toEqual([]);
  });

  it("turns backfills into paths with their timed, altitude-coloured points, skipping a single waypoint", () => {
    const track = (n: number) => ({
      icao24: "x",
      callsign: "AFR1 ",
      start_time: 0,
      end_time: 0,
      path: Array.from({ length: n }, (_, i) => ({
        time: i,
        latitude: 46 + i,
        longitude: -2,
        on_ground: false,
        ...(i === 0 ? { altitude_ft: 12_000 } : {}),
      })),
    });
    const d = openSkyMapData([], new Map(), new Set(), [], new Map([["A", track(3)], ["B", track(1)]]));
    expect(d.backfills).toEqual([
      {
        hex: "A",
        selectKey: "osky:A",
        callsign: "AFR1",
        path: [[46, -2], [47, -2], [48, -2]],
        points: [
          { lat: 46, lng: -2, time: 0, altitude: 12_000 },
          { lat: 47, lng: -2, time: 1, altitude: null },
          { lat: 48, lng: -2, time: 2, altitude: null },
        ],
      },
    ]);
  });
});

describe("OpenSky traces: whose they are, and hiding them", () => {
  const trackOf = (hex: string) => ({
    icao24: hex.toLowerCase(),
    callsign: null,
    start_time: 0,
    end_time: 0,
    path: [0, 1].map((i) => ({ time: i, latitude: 46 + i, longitude: -2, on_ground: false })),
  });

  it("selects the receiver's own aircraft from a backfill when it has one, the OpenSky one otherwise", () => {
    const local = { ...live("3C6444", NOW), track_id: "3C6444" };
    const d = openSkyMapData([], new Map([["3C6444", local]]), new Set(), [], new Map([
      ["3C6444", trackOf("3C6444")],
      ["39DE4F", trackOf("39DE4F")],
    ]));
    expect(d.backfills.map((b) => [b.hex, b.selectKey])).toEqual([
      ["3C6444", "3C6444"],
      ["39DE4F", "osky:39DE4F"],
    ]);
  });

  it("puts a flight history's switch on its recorded row, a backfill's on both rows of its aircraft", () => {
    const ownerOf = openSkyTraceOwners({ history: ["3C6444-7", "AAA111"], backfill: ["39DE4F"] });
    expect(ownerOf("history", "3C6444-7")).toBe(openSkyTraceKey("history", "3C6444-7"));
    expect(ownerOf("dbHistory", "3C6444-7")).toBe(openSkyTraceKey("history", "3C6444-7"));
    expect(ownerOf("analysis", "3C6444-7")).toBe(openSkyTraceKey("history", "3C6444-7"));
    expect(ownerOf("live", "39DE4F")).toBe(openSkyTraceKey("backfill", "39DE4F"));
    expect(ownerOf("opensky", "osky:39DE4F")).toBe(openSkyTraceKey("backfill", "39DE4F"));
    // A live row sharing a recorded flight's key is another aircraft's switch.
    expect(ownerOf("live", "AAA111")).toBeNull();
    expect(ownerOf("history", "39DE4F")).toBeNull();
    expect(ownerOf("live", "4CA123")).toBeNull();
  });

  it("keeps two kinds of trace apart, even for one key", () => {
    expect(openSkyTraceKey("history", "X")).not.toBe(openSkyTraceKey("backfill", "X"));
  });

  it("drops hidden backfills and histories, and nothing else", () => {
    const item = (key: string) => ({ key, selectKey: key, hex: key, callsign: null, path: [], gaps: [], waypoints: [] });
    const data = {
      ...EMPTY_OPENSKY_MAP,
      backfills: [
        { hex: "A", selectKey: "A", callsign: null, path: [], points: [] },
        { hex: "B", selectKey: "B", callsign: null, path: [], points: [] },
      ],
      history: [item("H1"), item("H2")],
    };
    const out = withoutHiddenTraces(data, new Set([openSkyTraceKey("backfill", "A"), openSkyTraceKey("history", "H2")]));
    expect(out.backfills.map((b) => b.hex)).toEqual(["B"]);
    expect(out.history.map((h) => h.key)).toEqual(["H1"]);
    expect(withoutHiddenTraces(data, new Set())).toBe(data);
  });
});

describe("externalTrackPoints", () => {
  it("gives each polled position of a live OpenSky track its time in seconds and its altitude", () => {
    const first = mergeStates(new Map(), poll([state("3c6444")]), NOW);
    const t = first.get("3C6444")!;
    const pts = externalTrackPoints({
      ...t,
      positions: [[47, -2, 30_000], [47.1, -2, null]],
      times: [NOW - 20_000, NOW - 10_000],
    });
    expect(pts).toEqual([
      { lat: 47, lng: -2, time: (NOW - 20_000) / 1000, altitude: 30_000 },
      { lat: 47.1, lng: -2, time: (NOW - 10_000) / 1000, altitude: null },
    ]);
  });
});

describe("pruneOpenSky — a dropped track takes its traces with it", () => {
  const backfillTrack = { icao24: "3c6444", start_time: 0, end_time: 0, path: [] };

  it("drops the backfill of an aircraft whose OpenSky track was dropped", () => {
    const external = mergeStates(new Map(), poll([state("3c6444"), state("39de4f")]), NOW);
    const backfill = new Map<string, BackfillEntry>([
      ["3C6444", { kind: "done", track: backfillTrack }],
      ["39DE4F", { kind: "done", track: backfillTrack }],
    ]);
    // Only 39de4f is still named by polls.
    const fresh = mergeStates(external, poll([state("39de4f", { time_position: NOW / 1000 + 60 })], NOW + 70_000), NOW + 70_000);
    const out = pruneOpenSky({ external: fresh, backfill }, NOW + 70_000, 60_000);
    expect([...out.external.keys()]).toEqual(["39DE4F"]);
    expect([...out.backfill.keys()]).toEqual(["39DE4F"]);
  });

  it("drops an area aircraft OpenSky still names but no longer places (frozen position)", () => {
    // Polled every few seconds, but its position never moves past NOW.
    const inArea = (fetched: number): StatesMessage => ({
      ...poll([state("3c6444")], fetched),
      states: [{ state: state("3c6444"), matched: [{ kind: "area", id: "w" }] }],
    });
    let external = mergeStates(new Map(), inArea(NOW), NOW);
    external = mergeStates(external, inArea(NOW + 200_000), NOW + 200_000);
    const out = pruneOpenSky({ external, backfill: new Map() }, NOW + 200_000, 60_000);
    expect(out.external.size).toBe(0);
    expect(POSITION_MAX_AGE_MS).toBeLessThan(200_000);
  });

  it("keeps a followed aircraft OpenSky still names after its position froze, undrawn", () => {
    let external = mergeStates(new Map(), poll([state("3c6444")]), NOW);
    external = mergeStates(external, poll([state("3c6444", { last_contact: NOW / 1000 + 195 })], NOW + 200_000), NOW + 200_000);
    const out = pruneOpenSky({ external, backfill: new Map() }, NOW + 200_000, 60_000);
    const t = out.external.get("3C6444")!;
    expect(t).toBeDefined();
    expect(t.latitude).toBeNull();
    expect(drawableExternal([t], NOW + 200_000)).toHaveLength(0);
  });

  it("keeps a backfill for an aircraft OpenSky never followed, and one still loading", () => {
    const backfill = new Map<string, BackfillEntry>([
      ["AAAAAA", { kind: "done", track: backfillTrack }],
      ["BBBBBB", { kind: "loading" }],
    ]);
    const out = pruneOpenSky({ external: new Map(), backfill }, NOW, 60_000);
    expect(out.backfill.size).toBe(2);
  });

  it("returns the same state when nothing changed, so React skips the render", () => {
    const external = mergeStates(new Map(), poll([state("3c6444")]), NOW);
    const s = { external, backfill: new Map<string, BackfillEntry>() };
    expect(pruneOpenSky(s, NOW + 1_000, 60_000)).toBe(s);
  });
});

describe("mergeStates — a frozen position is not taken back in", () => {
  it("ignores an area state whose position is older than POSITION_MAX_AGE_MS", () => {
    const old = state("3c6444", { time_position: (NOW - POSITION_MAX_AGE_MS - 1_000) / 1000 });
    const msg: StatesMessage = { ...poll([]), states: [{ state: old, matched: [{ kind: "area", id: "w" }] }] };
    expect(mergeStates(new Map(), msg, NOW).size).toBe(0);
  });

  it("lists a followed aircraft with a stale position, but draws nothing for it", () => {
    const old = state("3c6444", {
      time_position: (NOW - POSITION_MAX_AGE_MS - 1_000) / 1000,
      last_contact: NOW / 1000 - 3,
    });
    const t = mergeStates(new Map(), poll([old]), NOW).get("3C6444")!;
    expect(t.latitude).toBeNull();
    expect(t.longitude).toBeNull();
    expect(t.positions).toHaveLength(0);
    expect(t.position_ms).toBeNull();
    expect(t.last_seen).toBe(NOW - 3_000);
  });

  it("lists a followed aircraft OpenSky knows without any position", () => {
    const blind = state("3c6444", { time_position: null, latitude: null, longitude: null, last_contact: NOW / 1000 - 2 });
    const t = mergeStates(new Map(), poll([blind]), NOW).get("3C6444")!;
    expect(t.latitude).toBeNull();
    expect(t.positions).toHaveLength(0);
    expect(t.position_ms).toBeNull();
  });

  it("does not move a placed aircraft back to its last position once OpenSky stops placing it", () => {
    let m = mergeStates(new Map(), poll([state("3c6444")]), NOW);
    m = mergeStates(m, poll([state("3c6444", { time_position: null, latitude: null, longitude: null })], NOW + 10_000), NOW + 10_000);
    const t = m.get("3C6444")!;
    // The trail stays, the current position goes: nothing frozen is drawn as live.
    expect(t.positions).toHaveLength(1);
    expect(t.position_ms).toBe(NOW - 5_000);
    expect(drawableExternal([t], NOW + 10_000)).toHaveLength(1);
    expect(drawableExternal([t], NOW + POSITION_MAX_AGE_MS)).toHaveLength(0);
  });

  it("keeps a state whose position is recent", () => {
    const recent = state("3c6444", { time_position: (NOW - 30_000) / 1000 });
    expect(mergeStates(new Map(), poll([recent]), NOW).size).toBe(1);
  });
});

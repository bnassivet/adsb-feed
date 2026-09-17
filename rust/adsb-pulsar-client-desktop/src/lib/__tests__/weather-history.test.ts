import { describe, expect, it } from "vitest";
import {
  lruGet,
  lruPut,
  nearestSnapshotTime,
  parseRecordedSnapshot,
  selectAircraftWind,
  selectMapWeather,
  tracksTimeSpan,
  type HistoricalWeatherEntry,
} from "../weather-history";
import { STALE_AFTER_MS } from "../weather";
import type { WeatherSnapshot, WindFields } from "../weather";
import type { AircraftTrack, WeatherSnapshotMeta, WeatherSnapshotRecord } from "../types";

/** 2 x 2 grid over (46..47, -3..-2): uniform fields per level. */
function uniform(dir: number, speed: number, n = 4): WindFields {
  return { wind_dir_deg: Array(n).fill(dir), wind_speed_kt: Array(n).fill(speed) };
}

function snapshot(overrides: Partial<WeatherSnapshot> = {}): WeatherSnapshot {
  return {
    version: 1,
    source: "open-meteo",
    attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
    model: "best_match",
    fetched_at_ms: 0,
    valid_time_ms: 1_789_412_400_000,
    grid: { lat0: 46, lon0: -3, dlat: 1, dlon: 1, nlat: 2, nlon: 2 },
    surface: { ...uniform(270, 10), mslp_hpa: [1013, 1013, 1013, 1013] },
    levels: { "850": uniform(270, 20), "250": uniform(250, 100) },
    ...overrides,
  };
}

/** The columns a listing row and a full row share. */
const recorded = {
  source_id: "desktop",
  valid_time_ms: 1_789_412_400_000,
  fetched_at_ms: 1_789_413_000_000,
  received_at_ms: 1_789_413_060_000,
  source: "open-meteo",
  model: "best_match",
  version: 1,
  lat0: 46,
  lon0: -3,
  dlat: 1,
  dlon: 1,
  nlat: 2,
  nlon: 2,
  levels: "250,850",
};

/** A stored row carrying `payload` — by default the snapshot above, verbatim. */
function record(payload: string = JSON.stringify(snapshot())): WeatherSnapshotRecord {
  return { ...recorded, payload };
}

function meta(validTimeMs: number): WeatherSnapshotMeta {
  return { ...recorded, valid_time_ms: validTimeMs, payload_bytes: 16_011 };
}

function track(firstSeen: number, lastSeen: number): AircraftTrack {
  return {
    hex_ident: "A1B2C3",
    callsign: "AFR123",
    altitude: 34_000,
    ground_speed: 451,
    track: 263,
    latitude: 46.5,
    longitude: -2.5,
    vertical_rate: 0,
    squawk: "1000",
    is_on_ground: false,
    timestamp: "2026/09/17 10:30:00.000",
    positions: [],
    first_seen: firstSeen,
    last_seen: lastSeen,
    message_count: 12,
  };
}

const HOUR = 3_600_000;

describe("parseRecordedSnapshot", () => {
  it("parses the verbatim payload into a snapshot", () => {
    const parsed = parseRecordedSnapshot(record());
    expect(parsed).toEqual(snapshot());
  });

  it("rejects malformed JSON", () => {
    // A truncated row must not throw out of a render path.
    expect(parseRecordedSnapshot(record('{"version":1,"trunc'))).toBeNull();
  });

  it("rejects a payload that is not a snapshot", () => {
    // WeatherSnapshot is a structural interface with no runtime validation, so
    // without a guard this would parse cleanly and feed NaN into the
    // interpolation far from where the damage was done.
    expect(parseRecordedSnapshot(record('{"hello":1}'))).toBeNull();
  });

  it("rejects a future schema version", () => {
    // There is no migration mechanism: a SNAPSHOT_VERSION bump means old and
    // new rows coexist forever, so an unrecognised one is refused rather than
    // half-rendered.
    const future = JSON.stringify(snapshot({ version: 2 }));
    expect(parseRecordedSnapshot(record(future))).toBeNull();
  });

  it("rejects a snapshot whose fields do not match its grid", () => {
    const short = JSON.stringify(
      snapshot({ surface: { ...uniform(270, 10, 3), mslp_hpa: [1013, 1013, 1013] } }),
    );
    expect(parseRecordedSnapshot(record(short))).toBeNull();
  });
});

describe("nearestSnapshotTime", () => {
  const base = 1_789_412_400_000;

  it("picks the model hour nearest the requested time", () => {
    const hours = [meta(base), meta(base + HOUR), meta(base + 2 * HOUR)];
    expect(nearestSnapshotTime(hours, base + HOUR + 60_000, 3 * HOUR)).toBe(base + HOUR);
  });

  it("prefers the earlier hour on an exact tie", () => {
    // Determinism matters more than which side wins: a caller scrubbing across
    // a midpoint must not see the layer flicker between two hours.
    const hours = [meta(base), meta(base + HOUR)];
    expect(nearestSnapshotTime(hours, base + HOUR / 2, 3 * HOUR)).toBe(base);
  });

  it("ignores hours beyond the tolerance", () => {
    expect(nearestSnapshotTime([meta(base)], base + 5 * HOUR, 3 * HOUR)).toBeNull();
  });

  it("returns null when nothing was recorded", () => {
    expect(nearestSnapshotTime([], base, 3 * HOUR)).toBeNull();
  });

  it("looks both ways, not only backwards", () => {
    // The nearest recorded hour can be after the viewed time -- the service
    // publishes a short forecast in the back half of each hour.
    const hours = [meta(base - 3 * HOUR), meta(base + HOUR)];
    expect(nearestSnapshotTime(hours, base, 3 * HOUR)).toBe(base + HOUR);
  });
});

describe("tracksTimeSpan", () => {
  it("spans the earliest first_seen to the latest last_seen", () => {
    const span = tracksTimeSpan([
      track(3_000, 5_000),
      track(1_000, 2_000),
      track(4_000, 9_000),
    ]);
    expect(span).toEqual({ startMs: 1_000, endMs: 9_000 });
  });

  it("is null for an empty set", () => {
    // No tracks means no time to look weather up at -- which the UI explains
    // rather than silently falling back to the live snapshot.
    expect(tracksTimeSpan([])).toBeNull();
  });
});

describe("which weather the map draws", () => {
  const AT = 1_789_412_400_000;
  const live = snapshot({ valid_time_ms: AT });
  const recordedSnap = snapshot({ valid_time_ms: AT - 48 * HOUR, levels: { "850": uniform(90, 40) } });

  function entry(): HistoricalWeatherEntry {
    return {
      snapshot: recordedSnap,
      validTimeMs: AT - 48 * HOUR,
      requestedMs: AT - 48 * HOUR + 600_000,
      offsetMs: 600_000,
    };
  }

  const base = {
    show: true,
    availability: "available" as const,
    live,
    liveNowMs: AT,
    recorded: null,
    viewTimeMs: null,
  };

  it("draws the live snapshot in live mode", () => {
    const view = selectMapWeather({ ...base, isLive: true });
    expect(view.snapshot).toBe(live);
    expect(view.source).toBe("live");
  });

  it("never draws the live snapshot in analysis mode", () => {
    // THE BUG. Today page.tsx hands the live snapshot to the map with no
    // reference to the mode, so browsing a week-old track shows today's winds
    // over it -- silently, with nothing on screen saying so.
    const view = selectMapWeather({ ...base, isLive: false, recorded: null, viewTimeMs: AT - 48 * HOUR });
    expect(view.snapshot).toBeNull();
    expect(view.source).toBe("none");
  });

  it("draws the recorded snapshot for the time being viewed", () => {
    const view = selectMapWeather({
      ...base,
      isLive: false,
      recorded: entry(),
      viewTimeMs: AT - 48 * HOUR,
    });
    expect(view.snapshot).toBe(recordedSnap);
    expect(view.source).toBe("recorded");
    expect(view.atMs).toBe(AT - 48 * HOUR);
    expect(view.offsetMs).toBe(600_000);
  });

  it("draws recorded weather even on a socket source", () => {
    // Recorded weather comes out of DuckDB, not MQTT. A socket session reports
    // `unsupported_source` for the LIVE layer, but can still browse hours a
    // remote daemon recorded -- gating this would blank the feature for them.
    const view = selectMapWeather({
      ...base,
      isLive: false,
      availability: "unsupported_source",
      recorded: entry(),
      viewTimeMs: AT - 48 * HOUR,
    });
    expect(view.snapshot).toBe(recordedSnap);
  });

  it("draws nothing when the layer is switched off", () => {
    expect(selectMapWeather({ ...base, isLive: true, show: false }).snapshot).toBeNull();
  });

  it("draws nothing when there is no time to look up", () => {
    // An empty analysis set has no span, so there is no hour to ask for. The
    // UI explains that; it must not quietly fall back to live.
    const view = selectMapWeather({ ...base, isLive: false, viewTimeMs: null });
    expect(view.snapshot).toBeNull();
    expect(view.atMs).toBeNull();
  });

  it("keeps live mode byte-for-byte as it is today", () => {
    // The live branch must not regress: an unsupported source draws nothing.
    const view = selectMapWeather({ ...base, isLive: true, availability: "unsupported_source" });
    expect(view.snapshot).toBeNull();
  });
});

describe("which weather an aircraft's wind comes from", () => {
  const AT = 1_789_412_400_000;

  /**
   * Uniform through the whole column, surface included. `aircraftWind`
   * interpolates in ln(p) between the surface and the bracketing levels, so a
   * snapshot whose layers disagree would make these tests assert the
   * interpolation's arithmetic rather than which snapshot was chosen.
   */
  function column(dir: number, speed: number, validTimeMs: number): WeatherSnapshot {
    return snapshot({
      valid_time_ms: validTimeMs,
      surface: { ...uniform(dir, speed), mslp_hpa: [1013, 1013, 1013, 1013] },
      levels: { "850": uniform(dir, speed), "250": uniform(dir, speed) },
    });
  }

  const live = column(250, 100, AT);
  const recordedSnap = column(90, 40, AT - 48 * HOUR);
  const selected = track(AT - 48 * HOUR, AT - 48 * HOUR + 600_000);

  function entry(): HistoricalWeatherEntry {
    return {
      snapshot: recordedSnap,
      validTimeMs: AT - 48 * HOUR,
      requestedMs: selected.last_seen,
      offsetMs: 600_000,
    };
  }

  it("gives a historical selection the wind of its own recorded hour", () => {
    // Not today's wind, and not nothing: the whole point of recording.
    const wind = selectAircraftWind({
      track: selected,
      isHistoricalSelection: true,
      live,
      liveNowMs: AT,
      recorded: entry(),
    });
    expect(wind).not.toBeNull();
    expect(wind?.dirDeg).toBe(90);
  });

  it("gives a live selection the live snapshot", () => {
    const wind = selectAircraftWind({
      track: track(AT - 60_000, AT),
      isHistoricalSelection: false,
      live,
      liveNowMs: AT,
      recorded: null,
    });
    expect(wind).not.toBeNull();
    expect(wind?.dirDeg).toBe(250);
  });

  it("gives no wind for a stale live snapshot", () => {
    const wind = selectAircraftWind({
      track: track(AT - 60_000, AT),
      isHistoricalSelection: false,
      live,
      liveNowMs: AT + STALE_AFTER_MS + 1,
      recorded: null,
    });
    expect(wind).toBeNull();
  });

  it("gives no wind when nothing was recorded near that hour", () => {
    const wind = selectAircraftWind({
      track: selected,
      isHistoricalSelection: true,
      live,
      liveNowMs: AT,
      recorded: null,
    });
    expect(wind).toBeNull();
  });

  it("gives no wind for an aircraft on the ground", () => {
    // Delegated to aircraftWind, which already owns this guard -- the selector
    // routes which snapshot is used and must not duplicate it.
    const wind = selectAircraftWind({
      track: { ...selected, is_on_ground: true },
      isHistoricalSelection: true,
      live,
      liveNowMs: AT,
      recorded: entry(),
    });
    expect(wind).toBeNull();
  });
});

describe("the snapshot cache", () => {
  it("keeps a snapshot it has already been given", () => {
    const cache = new Map<number, string>();
    lruPut(cache, 1, "a", 3);
    expect(lruGet(cache, 1)).toBe("a");
  });

  it("evicts the least recently used past the cap", () => {
    // A snapshot is ~16 KB, so the cache is bounded rather than unbounded.
    const cache = new Map<number, string>();
    lruPut(cache, 1, "a", 2);
    lruPut(cache, 2, "b", 2);
    lruPut(cache, 3, "c", 2);
    expect(lruGet(cache, 1)).toBeUndefined();
    expect(lruGet(cache, 2)).toBe("b");
    expect(lruGet(cache, 3)).toBe("c");
  });

  it("a hit refreshes recency", () => {
    const cache = new Map<number, string>();
    lruPut(cache, 1, "a", 2);
    lruPut(cache, 2, "b", 2);
    lruGet(cache, 1); // 1 is now the most recent
    lruPut(cache, 3, "c", 2);
    expect(lruGet(cache, 1)).toBe("a");
    expect(lruGet(cache, 2)).toBeUndefined();
  });
});

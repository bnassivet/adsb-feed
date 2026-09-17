/**
 * Reading weather that was recorded, rather than the hour happening now.
 *
 * The recorder stores one snapshot per model hour. These are the pure pieces
 * the historical layer is built from: turning a stored row back into a
 * snapshot, choosing which recorded hour describes a given instant, working out
 * what span of time a set of tracks covers, and bounding the cache that keeps
 * ~16 KB payloads from being fetched twice.
 *
 * Everything here is free of React and of Tauri, so it is testable directly —
 * which matters because the map layer that consumes it deliberately is not.
 */

import { isStale, snapshotOffsetMs, type WeatherAvailability, type WeatherSnapshot } from "./weather";
import { aircraftWind, type AircraftWind } from "./aircraft-wind";
import type { AircraftTrack, WeatherSnapshotMeta, WeatherSnapshotRecord } from "./types";

/** The payload schema this app understands. */
const SUPPORTED_SNAPSHOT_VERSION = 1;

/** A closed interval of wall-clock time. */
export interface TimeSpan {
  startMs: number;
  endMs: number;
}

/**
 * Turns a stored row's payload back into a snapshot, or `null` if it cannot be
 * trusted.
 *
 * The payload is the JSON the weather service published, kept verbatim, and it
 * was validated once by the recorder before it was stored. It is validated
 * again here for a reason that is easy to miss: `WeatherSnapshot` is a
 * structural TypeScript interface with **no runtime validation**, so a row from
 * an older writer, a foreign receiver, or a future schema would `JSON.parse`
 * perfectly well and then feed `NaN` into `interpolateWind` — failing far from
 * where the damage was done.
 *
 * Absent and malformed deliberately collapse to the same answer, because the
 * honest thing to show for both is "no weather recorded for this time".
 */
export function parseRecordedSnapshot(
  record: WeatherSnapshotRecord,
): WeatherSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const snapshot = parsed as Partial<WeatherSnapshot>;
  if (snapshot.version !== SUPPORTED_SNAPSHOT_VERSION) return null;

  const grid = snapshot.grid;
  if (!grid) return null;
  for (const n of [grid.lat0, grid.lon0, grid.dlat, grid.dlon, grid.nlat, grid.nlon]) {
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
  }
  if (grid.nlat < 1 || grid.nlon < 1) return null;

  // Every per-point array must match the grid, or an index into one of them
  // silently reads undefined.
  const points = grid.nlat * grid.nlon;
  const surface = snapshot.surface;
  if (!surface) return null;
  for (const field of [surface.mslp_hpa, surface.wind_speed_kt, surface.wind_dir_deg]) {
    if (!Array.isArray(field) || field.length !== points) return null;
  }
  for (const fields of Object.values(snapshot.levels ?? {})) {
    for (const field of [fields.wind_speed_kt, fields.wind_dir_deg]) {
      if (!Array.isArray(field) || field.length !== points) return null;
    }
  }
  if (typeof snapshot.valid_time_ms !== "number") return null;

  return snapshot as WeatherSnapshot;
}

/**
 * The recorded model hour that best describes `atMs`, or `null` if none is
 * close enough.
 *
 * Looks **both ways**: the nearest hour can be later than the viewed time,
 * because the service publishes a short forecast in the back half of each hour.
 *
 * Ties resolve to the earlier hour. Which side wins matters less than that it
 * is deterministic — a caller scrubbing across the midpoint between two hours
 * must not see the layer flicker between them.
 */
export function nearestSnapshotTime(
  metas: WeatherSnapshotMeta[],
  atMs: number,
  toleranceMs: number,
): number | null {
  let best: number | null = null;
  let bestOffset = Number.POSITIVE_INFINITY;

  for (const meta of metas) {
    const offset = Math.abs(meta.valid_time_ms - atMs);
    if (offset > toleranceMs) continue;
    if (offset < bestOffset || (offset === bestOffset && best !== null && meta.valid_time_ms < best)) {
      best = meta.valid_time_ms;
      bestOffset = offset;
    }
  }
  return best;
}

/**
 * The span of time a set of tracks covers, or `null` when there are none.
 *
 * Analysis mode has no browse window of its own — its set is accumulated across
 * several browses — so the time to look weather up at is derived from the data
 * actually on screen rather than from the last window requested.
 */
export function tracksTimeSpan(tracks: AircraftTrack[]): TimeSpan | null {
  if (tracks.length === 0) return null;

  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const t of tracks) {
    if (t.first_seen < startMs) startMs = t.first_seen;
    if (t.last_seen > endMs) endMs = t.last_seen;
  }
  return { startMs, endMs };
}

/** Why a slot holds no recorded snapshot, or that it does. */
export type HistoricalWeatherStatus = "idle" | "loading" | "found" | "none" | "unavailable";

/**
 * What the controls need in order to describe recorded weather.
 *
 * Deliberately carries no snapshot. A status line needs the hour, the instant
 * viewed and why there is nothing — never the ~16 KB payload — so `WeatherControls`
 * stays a pure render of small values.
 */
export interface WeatherHistoryView {
  status: HistoricalWeatherStatus;
  /** The model hour found, or `null` unless `status` is `"found"`. */
  validTimeMs: number | null;
  /** The instant being viewed, or `null` when there is nothing to look up. */
  atMs: number | null;
  /** Whether the hour found is further from `atMs` than it should be. */
  offHour: boolean;
  /** Why nothing could be looked up — e.g. `"Storage not available"`. */
  error: string | null;
}

/** A recorded snapshot, with how far its model hour is from what was asked for. */
export interface HistoricalWeatherEntry {
  snapshot: WeatherSnapshot;
  /** The model hour actually found. */
  validTimeMs: number;
  /** The instant that was asked about. */
  requestedMs: number;
  /** `|validTimeMs - requestedMs|`. */
  offsetMs: number;
}

/** The weather the map should draw, and what instant it describes. */
export interface WeatherForView {
  snapshot: WeatherSnapshot | null;
  source: "live" | "recorded" | "none";
  /** The instant the weather is meant to describe: now, or the browsed time. */
  atMs: number | null;
  /** Distance from that instant to the snapshot's model hour. */
  offsetMs: number | null;
}

function nothing(atMs: number | null): WeatherForView {
  return { snapshot: null, source: "none", atMs, offsetMs: null };
}

/**
 * Chooses the snapshot the map draws.
 *
 * The rule that matters: in analysis mode this **never falls back to the live
 * snapshot**. Falling back is the bug this exists to fix — the map used to draw
 * the current hour over week-old tracks with nothing on screen saying so, which
 * is worse than drawing nothing, because it looks like an answer.
 *
 * `availability` gates only the live branch. Recorded weather comes out of
 * DuckDB rather than MQTT, so a session on the dump1090 socket source — which
 * reports `unsupported_source` — can still browse hours recorded earlier or by
 * a remote daemon.
 */
export function selectMapWeather(args: {
  isLive: boolean;
  show: boolean;
  availability: WeatherAvailability;
  live: WeatherSnapshot | null;
  liveNowMs: number;
  recorded: HistoricalWeatherEntry | null;
  viewTimeMs: number | null;
}): WeatherForView {
  if (!args.show) return nothing(null);

  if (args.isLive) {
    // Unchanged from what the map does today, so live mode cannot regress.
    if (args.availability === "unsupported_source" || !args.live) return nothing(args.liveNowMs);
    return {
      snapshot: args.live,
      source: "live",
      atMs: args.liveNowMs,
      offsetMs: snapshotOffsetMs(args.live, args.liveNowMs),
    };
  }

  if (!args.recorded) return nothing(args.viewTimeMs);
  return {
    snapshot: args.recorded.snapshot,
    source: "recorded",
    atMs: args.viewTimeMs,
    offsetMs: args.recorded.offsetMs,
  };
}

/**
 * Chooses the snapshot a selected aircraft's wind is read from.
 *
 * A historical selection gets the hour recorded nearest its own `last_seen`,
 * which is what lifts the old "live selections only" guard: that guard existed
 * because historical weather did not exist, not because the question was wrong.
 *
 * No staleness check on the recorded branch — the hour is by construction near
 * the track's own time, and how near is *reported* (`offsetMs`) rather than
 * used to suppress. On-ground and missing-field guards stay in `aircraftWind`,
 * which already owns them; this only routes which snapshot goes in.
 */
export function selectAircraftWind(args: {
  track: AircraftTrack;
  isHistoricalSelection: boolean;
  live: WeatherSnapshot | null;
  liveNowMs: number;
  recorded: HistoricalWeatherEntry | null;
}): AircraftWind | null {
  if (args.isHistoricalSelection) {
    return args.recorded ? aircraftWind(args.recorded.snapshot, args.track) : null;
  }
  if (!args.live || isStale(args.live, args.liveNowMs)) return null;
  return aircraftWind(args.live, args.track);
}

/**
 * Reads a cache entry and marks it most-recently-used.
 *
 * `Map` preserves insertion order, so recency is expressed by deleting and
 * re-inserting rather than by keeping a separate list.
 */
export function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key) as V;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

/**
 * Stores a cache entry, evicting the least recently used past `cap`.
 *
 * Bounded because the values are ~16 KB snapshots: a session that browsed a
 * week of history would otherwise hold every hour of it in memory.
 */
export function lruPut<K, V>(cache: Map<K, V>, key: K, value: V, cap: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > cap) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

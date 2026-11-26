/**
 * OpenSky flight history for a recorded track -- an Analysis flight, or a
 * History / DB History track in Live mode: the same flight as the receiver
 * recorded it, as OpenSky has it, drawn under the local trajectory.
 *
 * One endpoint does it: `/tracks/all?icao24=&time=T` returns the flight the
 * aircraft was on at T -- any moment of it -- with its callsign, start and end,
 * and sparse waypoints (one per 15 min at least, one per turn > 2.5° or
 * altitude change > 100 m). OpenSky keeps 30 days. Display only: nothing here
 * is recorded. DESIGN.md → OpenSky Gap Filling → Flight history.
 */
import { haversineDistanceNm } from "./geo";
import type { OpenSkyTrackReply } from "./commands";
import { isIcao24, waypointPoints, type OpenSkyPoint, type OpenSkyTrack, type OpenSkyWaypoint } from "./opensky";
import { trackKey, type AircraftTrack } from "./types";

/** How far back OpenSky keeps tracks. */
export const HISTORY_MAX_AGE_MS = 30 * 86_400_000;

/** An OpenSky waypoint farther than this from every local position is one the receiver missed. */
export const COVERED_NM = 5;

/** OpenSky's flight may end this long before the local one before a second call is made. */
const END_SLACK_MS = 60_000;

/** Local positions compared against, at most: day-long DB tracks hold thousands. */
const MAX_LOCAL_SAMPLES = 2_000;

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** What the details panel and the map hold for one recorded track. */
export type HistoryEntry =
  | { kind: "loading" }
  /** `stored`: every call was served from storage, so no credits were spent. */
  | { kind: "done"; track: OpenSkyTrack; gaps: HistoryGaps; stored: boolean }
  | { kind: "none" }
  | { kind: "mismatch"; reason: string }
  | { kind: "error"; message: string };

export interface HistoryGaps {
  /** Runs of OpenSky waypoints the receiver has nothing near. */
  count: number;
  /** Their total duration, from the covered waypoint before to the one after. */
  seconds: number;
  /** Each run as a polyline, bounded by the covered waypoints around it. */
  segments: [number, number][][];
}

/** When to ask OpenSky (epoch s): the middle of the local flight, then its end. */
export function historyQueryTimes(t: AircraftTrack): [number, number] {
  const mid = Math.round((t.first_seen + t.last_seen) / 2 / 1000);
  return [mid, Math.round(t.last_seen / 1000)];
}

/** The server's estimate for one call: 4 credits within a day, 30 beyond. */
export function historyCost(t: AircraftTrack, now: number): number {
  return now - historyQueryTimes(t)[0] * 1000 > 86_400_000 ? 30 : 4;
}

/** Why a fetch is impossible for this track, or null. */
export function historyUnavailable(
  t: AircraftTrack,
  now: number,
  service: { reachable: boolean; authenticated: boolean },
): string | null {
  if (!service.reachable) return "OpenSky service not reachable";
  if (!service.authenticated) return "Flight history needs OpenSky credentials";
  if (!isIcao24(t.hex_ident)) return "Not an ICAO address: nothing to ask OpenSky";
  if (now - t.last_seen > HISTORY_MAX_AGE_MS) return "OpenSky keeps tracks for 30 days only";
  return null;
}

function normaliseCallsign(c: string | null | undefined): string | null {
  const s = c?.trim().toUpperCase();
  return s ? s : null;
}

/** Whether OpenSky's flight is the local one: overlapping times, same callsign when both have one. */
export function sameFlight(
  local: AircraftTrack,
  osky: OpenSkyTrack,
): { ok: true } | { ok: false; reason: string } {
  const startMs = osky.start_time * 1000;
  const endMs = osky.end_time * 1000;
  if (endMs < local.first_seen || startMs > local.last_seen) {
    return { ok: false, reason: "its times do not overlap this flight's" };
  }
  const a = normaliseCallsign(local.callsign);
  const b = normaliseCallsign(osky.callsign);
  if (a && b && a !== b) return { ok: false, reason: `its callsign is ${b}, not ${a}` };
  return { ok: true };
}

/** Two tracks of one aircraft as one, waypoints in time order and unique by time. */
export function mergeTracks(a: OpenSkyTrack, b: OpenSkyTrack): OpenSkyTrack {
  const byTime = new Map<number, OpenSkyWaypoint>();
  for (const w of [...a.path, ...b.path]) if (!byTime.has(w.time)) byTime.set(w.time, w);
  return {
    icao24: a.icao24,
    callsign: a.callsign ?? b.callsign,
    start_time: Math.min(a.start_time, b.start_time),
    end_time: Math.max(a.end_time, b.end_time),
    path: [...byTime.values()].sort((x, y) => x.time - y.time),
  };
}

function localSamples(t: AircraftTrack): [number, number][] {
  const n = t.positions.length;
  const step = Math.max(1, Math.ceil(n / MAX_LOCAL_SAMPLES));
  const out: [number, number][] = [];
  for (let i = 0; i < n; i += step) {
    const p = Array.isArray(t.positions) ? t.positions[i] : t.positions.get(i);
    out.push([p[0], p[1]]);
  }
  return out;
}

/**
 * Where OpenSky fills the receiver's gaps. Local positions carry no time, so
 * coverage is spatial: a waypoint farther than {@link COVERED_NM} from every
 * local position is uncovered; OpenSky's waypoint times give the duration.
 */
export function historyGaps(local: AircraftTrack, osky: OpenSkyTrack): HistoryGaps {
  const samples = localSamples(local);
  const covered = (w: OpenSkyWaypoint) =>
    samples.some(([lat, lng]) => haversineDistanceNm(lat, lng, w.latitude, w.longitude) <= COVERED_NM);
  const path = osky.path;
  const segments: [number, number][][] = [];
  let seconds = 0;
  let i = 0;
  while (i < path.length) {
    if (covered(path[i])) {
      i++;
      continue;
    }
    const from = i > 0 ? i - 1 : i;
    let to = i;
    while (to < path.length && !covered(path[to])) to++;
    const end = to < path.length ? to : path.length - 1;
    segments.push(path.slice(from, end + 1).map((w) => [w.latitude, w.longitude] as [number, number]));
    seconds += path[end].time - path[from].time;
    i = to;
  }
  return { count: segments.length, seconds, segments };
}

/**
 * Fetches the local flight from OpenSky: once at its middle, and once more at
 * its end if OpenSky's flight stops short (a DB track that joined two flights
 * of one aircraft). Never more than two calls.
 */
export async function fetchFlightHistory(
  local: AircraftTrack,
  fetchTrack: (icao24: string, time: number) => Promise<OpenSkyTrackReply>,
): Promise<HistoryEntry> {
  const icao = local.hex_ident.toLowerCase();
  const [mid, end] = historyQueryTimes(local);
  try {
    const { track: first, stored: firstStored } = await fetchTrack(icao, mid);
    if (!first) return { kind: "none" };
    const match = sameFlight(local, first);
    if (!match.ok) return { kind: "mismatch", reason: match.reason };
    let track = first;
    let stored = firstStored;
    if (first.end_time * 1000 < local.last_seen - END_SLACK_MS) {
      const second = await fetchTrack(icao, end);
      stored &&= second.stored;
      if (second.track && sameFlight(local, second.track).ok) track = mergeTracks(first, second.track);
    }
    return { kind: "done", track, gaps: historyGaps(local, track), stored };
  } catch (error: unknown) {
    return { kind: "error", message: errorText(error) };
  }
}

/**
 * Which recorded tracks OpenSky history covers. `held`: every track whose
 * fetched flight is kept, in either mode, so switching Live <-> Analysis
 * discards nothing. `selectable`: the tracks the current mode offers a fetch on
 * -- never a live aircraft, whose flight is not over.
 */
export function openSkyHistoryScope(
  isLive: boolean,
  analysis: AircraftTrack[],
  history: AircraftTrack[],
  dbHistory: AircraftTrack[],
): { held: string[]; selectable: Set<string> } {
  const recorded = [...history, ...dbHistory].map(trackKey);
  const analysed = analysis.map(trackKey);
  return {
    held: [...new Set([...analysed, ...recorded])],
    selectable: new Set(isLive ? recorded : analysed),
  };
}

/** What the map draws for one fetched recorded flight. */
export interface HistoryMapItem {
  key: string;
  /** What a click on it selects: the recorded flight it is OpenSky's version of. */
  selectKey: string;
  /** OpenSky's identity for the flight, for the waypoint tooltips. */
  hex: string;
  callsign: string | null;
  path: [number, number][];
  /** The stretches OpenSky fills, drawn over the path. */
  gaps: [number, number][][];
  /** Coloured by altitude like the receiver's own points. */
  waypoints: OpenSkyPoint[];
}

/** The fetched flights, for the map; loading, missing and mismatched ones draw nothing. */
export function historyMapData(entries: Map<string, HistoryEntry>): HistoryMapItem[] {
  const out: HistoryMapItem[] = [];
  for (const [key, e] of entries) {
    if (e.kind !== "done") continue;
    out.push({
      key,
      selectKey: key,
      hex: e.track.icao24.toUpperCase(),
      callsign: e.track.callsign?.trim() || null,
      path: e.track.path.map((w) => [w.latitude, w.longitude] as [number, number]),
      gaps: e.gaps.segments,
      waypoints: waypointPoints(e.track.path),
    });
  }
  return out;
}

/**
 * OpenSky gap filling: types for what the OpenSky service publishes, and the
 * pure rules that decide what to watch and what to draw.
 *
 * The service (adsb-opensky-server) polls OpenSky for what this desktop asks:
 * the selected aircraft that the receiver has lost, and the areas drawn on the
 * map. Nothing it returns is recorded; it is drawn beside the local tracks,
 * hollow and dashed, and kept out of the live store entirely.
 *
 * Mirrors adsb-opensky-server's `states.rs`, `status.rs` and `api.rs`.
 */
import { haversineDistanceNm } from "./geo";
import { trackKey, type AircraftTrack, type TrackSection } from "./types";
import type { HistoryMapItem } from "./opensky-history";
import type { NoDataEntry } from "./opensky-backoff";

// ── Wire types ──────────────────────────────────────────────────────────────

export type OpenSkyServiceState =
  | "idle"
  | "polling"
  | "waiting"
  | "retrying"
  | "rate_limited"
  | "unauthorized"
  | "disabled";

export interface OpenSkyCredits {
  daily_limit: number;
  states_used_24h: number;
  tracks_used_24h: number;
  states_remaining?: number | null;
  tracks_remaining?: number | null;
}

export interface OpenSkyStatus {
  version: number;
  enabled: boolean;
  authenticated: boolean;
  state: OpenSkyServiceState;
  watch: { icao24: number; areas: number; clients: number };
  interval_seconds?: number | null;
  cycle_cost: number;
  credits: OpenSkyCredits;
  consecutive_failures: number;
  rate_limited_until_ms?: number | null;
  last_success_ms?: number | null;
  last_error?: string | null;
  next_poll_ms?: number | null;
  updated_at_ms: number;
}

export interface OpenSkyServiceView {
  status: OpenSkyStatus | null;
  availability: "online" | "offline" | null;
}

export const EMPTY_OPENSKY_VIEW: OpenSkyServiceView = { status: null, availability: null };

/** One aircraft as the service publishes it, in feet / knots / ft-per-min. */
export interface OpenSkyState {
  icao24: string;
  callsign?: string | null;
  origin_country?: string | null;
  /** Epoch seconds of the last position update. */
  time_position?: number | null;
  last_contact?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  altitude_ft?: number | null;
  geo_altitude_ft?: number | null;
  on_ground: boolean;
  ground_speed_kt?: number | null;
  track_deg?: number | null;
  vertical_rate_fpm?: number | null;
  squawk?: string | null;
  position_source?: string | null;
}

export type OpenSkyMatch = { kind: "aircraft" } | { kind: "area"; id: string };

export interface StatesMessage {
  version: number;
  fetched_ms: number;
  data_time: number;
  states: { state: OpenSkyState; matched: OpenSkyMatch[] }[];
}

/** A watched area. Longitudes do not wrap: west < east. */
export interface OpenSkyArea {
  id: string;
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface WatchAccepted {
  icao24: number;
  areas: number;
  lease_seconds: number;
  interval_seconds?: number | null;
}

export interface OpenSkyWaypoint {
  time: number;
  latitude: number;
  longitude: number;
  altitude_ft?: number | null;
  track_deg?: number | null;
  on_ground: boolean;
}

export interface OpenSkyTrack {
  icao24: string;
  callsign?: string | null;
  start_time: number;
  end_time: number;
  path: OpenSkyWaypoint[];
}

export interface HourCredits {
  hour_start_ms: number;
  states: number;
  tracks: number;
}

export interface CreditsReport {
  /** The allowance the service budgets against (feeder 8000, else 4000). */
  daily_limit: number;
  hours: HourCredits[];
  generated_ms: number;
  /** OpenSky's own remaining counts, from its last reply; absent until one. */
  states_remaining?: number | null;
  tracks_remaining?: number | null;
}

// ── Rules ───────────────────────────────────────────────────────────────────

/** A local track without a position for this long is "in a gap". */
export const GAP_THRESHOLD_MS = 20_000;
/** Stop following a lost aircraft this long after its last local position. */
export const LOSS_CAP_MS = 5 * 60_000;
/** ...or once OpenSky puts it this far from the receiver. */
export const DISTANCE_CAP_NM = 250;
/** The service's own cap on aircraft per client. */
export const MAX_WATCHED_AIRCRAFT = 20;
/** The service's own cap on areas per client. */
export const MAX_AREAS = 4;
/** The service refuses larger areas. */
export const MAX_AREA_SQ_DEG = 100;
/** The desktop renews its watch list this often; the service lease is 60 s. */
export const WATCH_RENEW_MS = 20_000;
/** Points kept per OpenSky track. */
export const MAX_EXTERNAL_POINTS = 300;
/** Prefix of the table/selection key of an OpenSky track. */
export const OPENSKY_KEY_PREFIX = "osky:";

/** "gaps": OpenSky only while the receiver has lost the aircraft. "always": both. */
export type OpenSkyMode = "gaps" | "always";

/** Local hex idents are uppercase; OpenSky's are lowercase. */
export function hexKey(hex: string): string {
  return hex.trim().toUpperCase();
}

/** Whether `hex` can be asked of OpenSky (six hex digits; not SIM-0001). */
export function isIcao24(hex: string): boolean {
  return /^[0-9a-fA-F]{6}$/.test(hex.trim());
}

/** The hex behind a selection key: a live hex, or an OpenSky row's key. */
export function selectionHex(key: string): string {
  return hexKey(key.startsWith(OPENSKY_KEY_PREFIX) ? key.slice(OPENSKY_KEY_PREFIX.length) : key);
}

/** When the receiver last placed the aircraft, or null if it never did. */
export function lastLocalPositionMs(track: AircraftTrack | undefined): number | null {
  if (!track) return null;
  return track.last_position_ms ?? (track.latitude !== null ? track.last_seen : null);
}

/** Whether the receiver has a fresh position for this aircraft. */
export function isLocallyFresh(track: AircraftTrack | undefined, now: number): boolean {
  const last = lastLocalPositionMs(track);
  return last !== null && now - last < GAP_THRESHOLD_MS;
}

/** OpenSky's charge for one poll of an area, as the service computes it. */
export function areaSqDeg(a: OpenSkyArea): number {
  return Math.abs(a.north - a.south) * Math.abs(a.east - a.west);
}

export function areaCost(a: OpenSkyArea): number {
  const sq = areaSqDeg(a);
  if (sq <= 25) return 1;
  if (sq <= 100) return 2;
  if (sq <= 400) return 3;
  return 4;
}

export interface WatchInputs {
  /** The aircraft the user follows (live hexes or osky: keys): never the
   *  selection, so credits are spent only on request. */
  followed: Iterable<string>;
  /** Live tracks by uppercase hex. */
  live: Map<string, AircraftTrack>;
  /** OpenSky tracks held, by uppercase hex. */
  external: Map<string, ExternalTrack>;
  receiver: { lat: number; lng: number } | null;
  mode: OpenSkyMode;
  now: number;
  /** Uppercase hexes the no-data backoff holds back (opensky-backoff.ts). */
  heldBack?: ReadonlySet<string>;
}

/**
 * The aircraft to ask OpenSky for: lowercase icao24s, sorted, at most
 * {@link MAX_WATCHED_AIRCRAFT}.
 *
 * A followed aircraft is watched while it is followed, except:
 * - in "gaps" mode, while the receiver still has it (fresh position);
 * - once {@link LOSS_CAP_MS} has passed since its last local position;
 * - once OpenSky places it beyond {@link DISTANCE_CAP_NM} of the receiver.
 * - while the no-data backoff holds it back (`heldBack`).
 * An aircraft the receiver never placed has no loss time, so only the distance
 * cap and the no-data backoff end its watch.
 */
export function computeWatch(inputs: WatchInputs): string[] {
  const { live, external, receiver, mode, now } = inputs;
  const out = new Set<string>();
  for (const key of inputs.followed) {
    const hex = selectionHex(key);
    if (!isIcao24(hex)) continue;
    if (inputs.heldBack?.has(hex)) continue;
    const local = live.get(hex);
    const lastLocal = lastLocalPositionMs(local);
    if (mode === "gaps" && lastLocal !== null && now - lastLocal < GAP_THRESHOLD_MS) continue;
    if (lastLocal !== null && now - lastLocal > LOSS_CAP_MS) continue;
    const ext = external.get(hex);
    if (receiver && ext?.latitude != null && ext.longitude != null) {
      const d = haversineDistanceNm(receiver.lat, receiver.lng, ext.latitude, ext.longitude);
      if (d > DISTANCE_CAP_NM) continue;
    }
    out.add(hex.toLowerCase());
  }
  return [...out].sort().slice(0, MAX_WATCHED_AIRCRAFT);
}

/** A value signature, so an effect re-runs on content, not array identity. */
export function watchSignature(icao24: string[], areas: OpenSkyArea[]): string {
  const a = areas.map((x) => `${x.id}:${x.north},${x.south},${x.east},${x.west}`).join("|");
  return `${icao24.join(",")}#${a}`;
}

// ── External tracks ─────────────────────────────────────────────────────────

/**
 * An OpenSky aircraft, shaped like a track so the table, the details panel and
 * the selection machinery take it as is. `track_id` is `osky:<HEX>`, so it
 * never collides with the live track of the same aircraft.
 */
export interface ExternalTrack extends AircraftTrack {
  track_id: string;
  source: "opensky";
  matched: OpenSkyMatch[];
  /** Epoch ms of each entry of `positions`. */
  times: number[];
  /** When the last poll mentioned it, epoch ms. */
  last_update_ms: number;
  /** When OpenSky last placed it, epoch ms, or null if it never did. A track
   *  is drawn only while this is fresh ({@link drawableExternal}); one OpenSky
   *  names without a position is listed, not drawn. */
  position_ms: number | null;
  origin_country: string | null;
}

/** Whether a poll named the aircraft because it is followed, not for an area. */
function isFollowedMatch(matched: OpenSkyMatch[]): boolean {
  return matched.some((m) => m.kind === "aircraft");
}

/**
 * Folds one poll into the held tracks. Returns a new map: every aircraft in
 * the poll is updated, every other one is kept until {@link pruneExternal}
 * drops it.
 *
 * A followed aircraft is kept even when OpenSky has no fresh position for it:
 * it is listed (the user asked for it, and "OpenSky knows it, unplaced" is an
 * answer), but its position is null so nothing frozen is drawn. An aircraft
 * named only by an area needs a fresh position, or it is not taken in.
 */
export function mergeStates(
  held: Map<string, ExternalTrack>,
  message: StatesMessage,
  now: number,
): Map<string, ExternalTrack> {
  const next = new Map(held);
  for (const { state, matched } of message.states) {
    const hex = hexKey(state.icao24);
    const prev = next.get(hex);
    const positions = prev ? [...(prev.positions as [number, number, number | null][])] : [];
    const times = prev ? [...prev.times] : [];
    const contactMs = (state.last_contact ?? state.time_position ?? message.data_time) * 1000;
    const placed = state.latitude != null && state.longitude != null;
    const posTime = placed ? (state.time_position ?? state.last_contact ?? message.data_time) * 1000 : null;
    // A position OpenSky no longer updates is not drawn, and must not come
    // back with every poll after pruneExternal dropped it.
    const fresh = posTime !== null && now - posTime <= POSITION_MAX_AGE_MS;
    if (!fresh && !isFollowedMatch(matched)) continue;
    if (fresh) {
      const lastTime = times.length > 0 ? times[times.length - 1] : -Infinity;
      if (posTime > lastTime) {
        positions.push([state.latitude!, state.longitude!, state.altitude_ft ?? null]);
        times.push(posTime);
        while (positions.length > MAX_EXTERNAL_POINTS) {
          positions.shift();
          times.shift();
        }
      }
    }
    // Without a fresh fix, the previous one stands only while it is fresh itself.
    const keepPrev = !fresh && prev?.position_ms != null && now - prev.position_ms <= POSITION_MAX_AGE_MS;
    const position_ms = fresh ? Math.max(posTime, prev?.position_ms ?? -Infinity) : keepPrev ? prev!.position_ms : null;
    next.set(hex, {
      hex_ident: hex,
      track_id: `${OPENSKY_KEY_PREFIX}${hex}`,
      source: "opensky",
      callsign: state.callsign ?? prev?.callsign ?? null,
      altitude: state.altitude_ft ?? null,
      ground_speed: state.ground_speed_kt ?? null,
      track: state.track_deg ?? null,
      latitude: fresh ? state.latitude! : keepPrev ? prev!.latitude : null,
      longitude: fresh ? state.longitude! : keepPrev ? prev!.longitude : null,
      vertical_rate: state.vertical_rate_fpm ?? null,
      squawk: state.squawk ?? null,
      is_on_ground: state.on_ground,
      timestamp: new Date(contactMs).toISOString(),
      positions,
      times,
      first_seen: prev?.first_seen ?? now,
      last_seen: contactMs,
      message_count: 0,
      matched,
      last_update_ms: now,
      position_ms,
      origin_country: state.origin_country ?? null,
    });
  }
  return next;
}

/** How long an aircraft no poll mentions stays drawn. */
export function staleAfterMs(intervalSeconds: number | null | undefined): number {
  return Math.max(60_000, 2.5 * (intervalSeconds ?? 0) * 1000);
}

/**
 * Drops aircraft the polls stopped mentioning: one that left a watched area,
 * or that is no longer watched. Returns the same map when nothing changed.
 */
export function pruneExternal(
  held: Map<string, ExternalTrack>,
  now: number,
  staleMs: number,
): Map<string, ExternalTrack> {
  let changed = false;
  const next = new Map<string, ExternalTrack>();
  for (const [hex, t] of held) {
    if (isDropped(t, now, staleMs)) changed = true;
    else next.set(hex, t);
  }
  return changed ? next : held;
}

/**
 * Oldest OpenSky position still drawn. OpenSky keeps naming an aircraft it has
 * lost, with its last position, for a while; polls then refresh the track
 * without moving it, and a frozen aircraft would stay on the map for as long
 * as it is watched.
 */
export const POSITION_MAX_AGE_MS = 120_000;

/**
 * A track is dropped when polls stop naming it. One named only for an area is
 * also dropped once OpenSky stops placing it; a followed one stays listed.
 */
function isDropped(t: ExternalTrack, now: number, staleMs: number): boolean {
  if (now - t.last_update_ms > staleMs) return true;
  if (isFollowedMatch(t.matched)) return false;
  return t.position_ms === null || now - t.position_ms > Math.max(staleMs, POSITION_MAX_AGE_MS);
}

/** A track backfill asked for in the details panel. */
export type BackfillEntry =
  | { kind: "loading" }
  | { kind: "done"; track: OpenSkyTrack }
  | { kind: "none" }
  | { kind: "error"; message: string };

/** What the OpenSky layer holds: live tracks and the backfills drawn for them. */
export interface OpenSkyHeld {
  external: Map<string, ExternalTrack>;
  backfill: Map<string, BackfillEntry>;
}

/**
 * Drops dropped tracks *and every trace drawn for them*: an aircraft whose
 * OpenSky track goes loses its backfilled path in the same step. A backfill
 * for an aircraft OpenSky was never following (asked for while the receiver
 * still had it) is not tied to a track and stays until hidden. Returns the
 * same object when nothing changed.
 */
export function pruneOpenSky(held: OpenSkyHeld, now: number, staleMs: number): OpenSkyHeld {
  const external = pruneExternal(held.external, now, staleMs);
  if (external === held.external) return held;
  let backfill = held.backfill;
  for (const hex of held.external.keys()) {
    if (!external.has(hex) && backfill.has(hex)) {
      if (backfill === held.backfill) backfill = new Map(backfill);
      backfill.delete(hex);
    }
  }
  return { external, backfill };
}

/**
 * The OpenSky tracks to list. In "gaps" mode an aircraft the receiver has a
 * fresh position for is not shown twice; in "always" mode both are. Tracks
 * OpenSky has no position for are listed: {@link drawableExternal} keeps
 * those off the map.
 */
export function visibleExternal(
  held: Map<string, ExternalTrack>,
  live: Map<string, AircraftTrack>,
  mode: OpenSkyMode,
  now: number,
): ExternalTrack[] {
  const out: ExternalTrack[] = [];
  for (const [hex, t] of held) {
    if (mode === "gaps" && isLocallyFresh(live.get(hex), now)) continue;
    out.push(t);
  }
  return out.sort((a, b) => a.hex_ident.localeCompare(b.hex_ident));
}

/** The listed OpenSky tracks that can be drawn: placed, and placed recently. */
export function drawableExternal(tracks: ExternalTrack[], now: number): ExternalTrack[] {
  return tracks.filter(
    (t) =>
      t.latitude != null &&
      t.longitude != null &&
      t.position_ms != null &&
      now - t.position_ms <= POSITION_MAX_AGE_MS,
  );
}

/**
 * What following an aircraft has produced so far, for the details panel:
 * - `not-followed`: nothing asked;
 * - `pending`: followed, not asked for yet (the receiver still has it);
 * - `waiting-answer`: asked, no answer about it yet;
 * - `no-data`: polls came back without it; asked again later (backoff);
 * - `gave-up`: no data for 5 min (NO_DATA_GIVE_UP_MS): no longer asked;
 * - `no-position`: OpenSky names it, without a fresh position;
 * - `placed`: OpenSky has a fresh position.
 */
export type OpenSkyFollowStatus =
  | "not-followed"
  | "pending"
  | "waiting-answer"
  | "no-data"
  | "gave-up"
  | "no-position"
  | "placed";

export function openSkyFollowStatus(inputs: {
  followed: boolean;
  watched: boolean;
  external: ExternalTrack | undefined;
  /** Its no-data backoff entry, if any. */
  noData: NoDataEntry | undefined;
  now: number;
}): OpenSkyFollowStatus {
  const { followed, watched, external, noData, now } = inputs;
  if (external && drawableExternal([external], now).length > 0) return "placed";
  if (!followed) return "not-followed";
  if (external) return "no-position";
  if (noData) return noData.stopped ? "gave-up" : "no-data";
  return watched ? "waiting-answer" : "pending";
}

// ── Credits ─────────────────────────────────────────────────────────────────

export type CreditLevel = "ok" | "warn" | "high";

/** Colour band of the credit counter: amber from 70 %, red from 90 % or while rate limited. */
export function creditLevel(used: number, limit: number, rateLimited = false): CreditLevel {
  if (rateLimited) return "high";
  if (limit <= 0) return "ok";
  const f = used / limit;
  if (f >= 0.9) return "high";
  if (f >= 0.7) return "warn";
  return "ok";
}

/** Hourly average the budget allows, for the Analytics reference line. */
export function hourlyAllowance(dailyLimit: number): number {
  return (dailyLimit * 0.9) / 24;
}

// ── Map ─────────────────────────────────────────────────────────────────────

/**
 * One position OpenSky filled in, drawn as a dot like the receiver's own:
 * `time` in epoch seconds, `altitude` in feet (null when OpenSky has none).
 */
export interface OpenSkyPoint {
  lat: number;
  lng: number;
  time: number;
  altitude: number | null;
}

/** A track's waypoints as map points. */
export function waypointPoints(path: OpenSkyWaypoint[]): OpenSkyPoint[] {
  return path.map((w) => ({ lat: w.latitude, lng: w.longitude, time: w.time, altitude: w.altitude_ft ?? null }));
}

/** A live OpenSky track's polled positions as map points. */
export function externalTrackPoints(t: ExternalTrack): OpenSkyPoint[] {
  const p = t.positions as [number, number, number | null][];
  return p.map(([lat, lng, alt], i) => ({ lat, lng, time: t.times[i] / 1000, altitude: alt ?? null }));
}

/** Everything the map draws for OpenSky, in one value. */
export interface OpenSkyMapData {
  tracks: ExternalTrack[];
  areas: OpenSkyArea[];
  /** Dashed segments from where the receiver lost a selected aircraft to
   *  where OpenSky first has it, so the gap reads as a gap. */
  connectors: { hex: string; from: [number, number]; to: [number, number] }[];
  /** Backfilled OpenSky tracks (sparse waypoints). */
  backfills: {
    hex: string;
    /** What a click on it selects: the receiver's own aircraft, or OpenSky's. */
    selectKey: string;
    callsign: string | null;
    path: [number, number][];
    points: OpenSkyPoint[];
  }[];
  /** OpenSky's version of Analysis-mode flights (opensky-history.ts). */
  history: HistoryMapItem[];
}

export const EMPTY_OPENSKY_MAP: OpenSkyMapData = { tracks: [], areas: [], connectors: [], backfills: [], history: [] };

function lastLatLng(t: AircraftTrack): [number, number] | null {
  return t.latitude != null && t.longitude != null ? [t.latitude, t.longitude] : null;
}

function firstLatLng(t: ExternalTrack): [number, number] | null {
  const p = t.positions as [number, number, number | null][];
  return p.length > 0 ? [p[0][0], p[0][1]] : lastLatLng(t);
}

export function openSkyMapData(
  visible: ExternalTrack[],
  live: Map<string, AircraftTrack>,
  selectedHexes: Set<string>,
  areas: OpenSkyArea[],
  backfills: Map<string, OpenSkyTrack>,
): OpenSkyMapData {
  const connectors: OpenSkyMapData["connectors"] = [];
  for (const t of visible) {
    if (!selectedHexes.has(t.hex_ident)) continue;
    const local = live.get(t.hex_ident);
    const from = local ? lastLatLng(local) : null;
    const to = firstLatLng(t);
    if (from && to) connectors.push({ hex: t.hex_ident, from, to });
  }
  const paths: OpenSkyMapData["backfills"] = [];
  for (const [hex, track] of backfills) {
    if (track.path.length > 1) {
      const local = live.get(hex);
      paths.push({
        hex,
        selectKey: local ? trackKey(local) : `${OPENSKY_KEY_PREFIX}${hex}`,
        callsign: track.callsign?.trim() || null,
        path: track.path.map((w) => [w.latitude, w.longitude] as [number, number]),
        points: waypointPoints(track.path),
      });
    }
  }
  return { tracks: visible, areas, connectors, backfills: paths, history: [] };
}

// ── Trace visibility ────────────────────────────────────────────────────────

/** A drawn OpenSky trace: OpenSky's version of a recorded flight, or a backfill. */
export type OpenSkyTraceKind = "history" | "backfill";

/** One trace's key in the hidden set: by its owner's key, kinds kept apart. */
export function openSkyTraceKey(kind: OpenSkyTraceKind, ownerKey: string): string {
  return `${kind}:${ownerKey}`;
}

/**
 * Which trace a table row carries the show/hide switch of, or null. A flight
 * history belongs to its recorded track's row (History, DB History, Analysis);
 * a backfill to its aircraft, on the receiver's row and OpenSky's row alike --
 * one aircraft, one switch. By section as well as key: a live row may share a
 * recorded flight's key.
 */
export function openSkyTraceOwners(traces: {
  /** Keys of the recorded tracks whose OpenSky flight is drawn. */
  history: Iterable<string>;
  /** HEXes of the drawn backfills. */
  backfill: Iterable<string>;
}): (section: TrackSection, rowKey: string) => string | null {
  const history = new Set(traces.history);
  const backfill = new Set(traces.backfill);
  return (section, rowKey) => {
    if (section === "live" || section === "opensky") {
      const hex = selectionHex(rowKey);
      return backfill.has(hex) ? openSkyTraceKey("backfill", hex) : null;
    }
    return history.has(rowKey) ? openSkyTraceKey("history", rowKey) : null;
  };
}

/** The map data without the traces the user hid. */
export function withoutHiddenTraces(data: OpenSkyMapData, hidden: Set<string>): OpenSkyMapData {
  if (hidden.size === 0) return data;
  return {
    ...data,
    backfills: data.backfills.filter((b) => !hidden.has(openSkyTraceKey("backfill", b.hex))),
    history: data.history.filter((h) => !hidden.has(openSkyTraceKey("history", h.key))),
  };
}

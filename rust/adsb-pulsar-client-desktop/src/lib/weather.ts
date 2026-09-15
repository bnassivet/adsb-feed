/**
 * Weather snapshots and the arithmetic the map and the aircraft details panel
 * need: grid lookup, interpolation, ISA pressure altitude, wind components and
 * wind-barb geometry. Pure functions, no React.
 *
 * Mirrors adsb-weather-server's `WeatherSnapshot`: snake_case, epoch
 * milliseconds, flat arrays in row-major order from the south-west corner
 * (`index = row * nlon + col`), `null` where the model had no value.
 */

export interface WeatherGrid {
  lat0: number;
  lon0: number;
  dlat: number;
  dlon: number;
  nlat: number;
  nlon: number;
}

export interface WindFields {
  wind_speed_kt: (number | null)[];
  /** Direction the wind blows FROM, degrees true. */
  wind_dir_deg: (number | null)[];
}

export interface WeatherSnapshot {
  version: number;
  source: string;
  /** Credit line the data licence requires to be displayed. */
  attribution: string;
  model: string;
  fetched_at_ms: number;
  /** The model hour the data is valid for. */
  valid_time_ms: number;
  grid: WeatherGrid;
  surface: WindFields & { mslp_hpa: (number | null)[] };
  /** Keyed by pressure level in hPa, as a string: `levels["250"]`. */
  levels: Record<string, WindFields>;
}

/** Mirrors the Rust `WeatherAvailability` (serde snake_case). */
export type WeatherAvailability = "available" | "waiting" | "unsupported_source";

/** Mirrors adsb-weather-server's `ServiceState`: what the service is doing. */
export type WeatherServiceState =
  | "idle"
  | "fetching"
  | "retrying"
  | "rate_limited"
  | "rejected"
  | "disabled";

/** Mirrors adsb-weather-server's `RateLimitScope`. */
export type RateLimitScope = "minutely" | "hourly" | "daily" | "unknown";

/** Mirrors adsb-weather-server's `WeatherStatus`, published on the status topic. */
export interface WeatherServiceStatus {
  version: number;
  /** Desired: the operator's accepted, persisted setting. */
  enabled: boolean;
  /** Reported: what the service is doing about it. */
  state: WeatherServiceState;
  consecutive_failures: number;
  rate_limit: RateLimitScope | null;
  last_success_ms: number | null;
  last_error: string | null;
  next_fetch_ms: number | null;
  snapshot_valid_time_ms: number | null;
  updated_at_ms: number;
}

/** The service's MQTT birth / last-will payload. */
export type WeatherServiceAvailability = "online" | "offline";

/** Mirrors the desktop's `WeatherServiceView`: what the service last reported. */
export interface WeatherServiceView {
  status: WeatherServiceStatus | null;
  availability: WeatherServiceAvailability | null;
}

export const EMPTY_SERVICE_VIEW: WeatherServiceView = { status: null, availability: null };

/** `"surface"` or a pressure level in hPa. */
export type WeatherLevel = "surface" | number;

export interface Wind {
  /** Direction the wind blows FROM, degrees true, [0, 360). */
  dirDeg: number;
  speedKt: number;
}

export interface WindComponents {
  /** Positive: headwind. Negative: tailwind. */
  headwindKt: number;
  /** Positive: from the right of the track. Negative: from the left. */
  crosswindKt: number;
}

export interface BarbParts {
  /** 50 kt each. */
  pennants: number;
  /** 10 kt each. */
  full: number;
  /** 0 or 1, 5 kt. */
  half: number;
  /** Under 5 kt: drawn as a circle, no shaft. */
  calm: boolean;
}

/** Past this age the layer is flagged stale. Model data refreshes hourly. */
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

/**
 * Above the highest fetched level, its wind is reused up to this pressure
 * (about FL450) rather than extrapolated; beyond it the wind is unknown.
 */
export const TOP_LEVEL_HOLD_HPA = 150;

/** ISA sea-level pressure, hPa. Pressure altitude is referenced to it. */
export const ISA_SEA_LEVEL_HPA = 1013.25;

const DEG = Math.PI / 180;

// ISA below the tropopause: p = p0 * (1 - k * h)^n, h in feet.
const ISA_LAPSE_PER_FT = 6.8755856e-6;
const ISA_EXPONENT = 5.2558797;
// Above it the layer is isothermal: p = pT * exp(-(h - hT) / H).
const TROPOPAUSE_FT = 36_089;
const TROPOPAUSE_HPA = 226.32;
const STRATOSPHERE_SCALE_HEIGHT_FT = 20_806;

/** Tolerance for points that sit exactly on the grid edge. */
const GRID_EPS = 1e-9;

/**
 * Pressure (hPa) at a pressure altitude (ft), per the International Standard
 * Atmosphere: a power law up to the tropopause at 36,089 ft, then an
 * exponential decay in the isothermal layer above it.
 *
 * SBS-1 altitudes are barometric pressure altitudes referenced to 1013.25 hPa,
 * which is exactly what this converts -- no geopotential height needed.
 */
export function pressureAltitudeToHpa(altitudeFt: number): number {
  if (altitudeFt <= TROPOPAUSE_FT) {
    return ISA_SEA_LEVEL_HPA * Math.pow(1 - ISA_LAPSE_PER_FT * altitudeFt, ISA_EXPONENT);
  }
  return TROPOPAUSE_HPA * Math.exp(-(altitudeFt - TROPOPAUSE_FT) / STRATOSPHERE_SCALE_HEIGHT_FT);
}

/** Flight level (hundreds of feet, rounded to the nearest 10) for a pressure. */
export function hpaToFlightLevel(hpa: number): number {
  const feet =
    hpa >= TROPOPAUSE_HPA
      ? (1 - Math.pow(hpa / ISA_SEA_LEVEL_HPA, 1 / ISA_EXPONENT)) / ISA_LAPSE_PER_FT
      : TROPOPAUSE_FT - STRATOSPHERE_SCALE_HEIGHT_FT * Math.log(hpa / TROPOPAUSE_HPA);
  return Math.round(feet / 1000) * 10;
}

/** The snapshot's pressure levels, highest pressure (lowest altitude) first. */
export function availableLevels(snapshot: WeatherSnapshot): number[] {
  return Object.keys(snapshot.levels)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
}

/** `"SFC"`, or `"FL340 · 250 hPa"`. */
export function levelLabel(level: WeatherLevel): string {
  if (level === "surface") return "SFC";
  const fl = String(hpaToFlightLevel(level)).padStart(3, "0");
  return `FL${fl} · ${level} hPa`;
}

/** Rounds to 1e-6 degrees, and turns -0 into 0. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6 || 0;
}

function wrapLon(lon: number): number {
  return round6(((((lon + 180) % 360) + 360) % 360) - 180);
}

/** Every grid point with its index, row-major, longitude in [-180, 180). */
export function gridPoints(
  snapshot: WeatherSnapshot,
): { lat: number; lon: number; index: number }[] {
  const { lat0, lon0, dlat, dlon, nlat, nlon } = snapshot.grid;
  const points: { lat: number; lon: number; index: number }[] = [];
  for (let row = 0; row < nlat; row++) {
    for (let col = 0; col < nlon; col++) {
      points.push({
        lat: round6(lat0 + row * dlat),
        lon: wrapLon(lon0 + col * dlon),
        index: row * nlon + col,
      });
    }
  }
  return points;
}

/** The wind fields for a level, or null if the snapshot does not carry it. */
export function fieldsAt(snapshot: WeatherSnapshot, level: WeatherLevel): WindFields | null {
  if (level === "surface") return snapshot.surface;
  return snapshot.levels[String(level)] ?? null;
}

/** The wind at one grid point, or null where either value is missing. */
export function windAtPoint(fields: WindFields, index: number): Wind | null {
  const dirDeg = fields.wind_dir_deg[index];
  const speedKt = fields.wind_speed_kt[index];
  if (dirDeg == null || speedKt == null) return null;
  if (!Number.isFinite(dirDeg) || !Number.isFinite(speedKt)) return null;
  return { dirDeg, speedKt };
}

/**
 * The vector the air moves along (u east, v north). A wind FROM 270° blows
 * east, so it has positive u.
 */
function toUV(wind: Wind): [number, number] {
  const r = wind.dirDeg * DEG;
  return [-wind.speedKt * Math.sin(r), -wind.speedKt * Math.cos(r)];
}

function fromUV(u: number, v: number): Wind {
  const speedKt = Math.hypot(u, v);
  if (speedKt < 1e-9) return { dirDeg: 0, speedKt: 0 };
  return { dirDeg: (Math.atan2(-u, -v) / DEG + 360) % 360, speedKt };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

interface Cell {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
  /** Fractions within the cell, 0..1. */
  fr: number;
  fc: number;
}

/** The grid cell containing a position, or null outside the grid. */
function locate(grid: WeatherGrid, lat: number, lon: number): Cell | null {
  const { lat0, lon0, dlat, dlon, nlat, nlon } = grid;
  if (nlat < 1 || nlon < 1) return null;
  const r = (lat - lat0) / dlat;
  // Measured eastward from lon0, so a grid crossing the antimeridian works.
  const c = ((((lon - lon0) % 360) + 360) % 360) / dlon;
  if (!Number.isFinite(r) || !Number.isFinite(c)) return null;
  if (r < -GRID_EPS || r > nlat - 1 + GRID_EPS || c > nlon - 1 + GRID_EPS) return null;

  const rr = Math.min(Math.max(r, 0), nlat - 1);
  const cc = Math.min(c, nlon - 1);
  const r0 = Math.floor(rr);
  const c0 = Math.floor(cc);
  return {
    r0,
    c0,
    r1: Math.min(r0 + 1, nlat - 1),
    c1: Math.min(c0 + 1, nlon - 1),
    fr: rr - r0,
    fc: cc - c0,
  };
}

/**
 * Wind at a position on one level, bilinearly interpolated between the four
 * surrounding grid points. Null outside the grid or where a corner is missing.
 *
 * Interpolated as u/v vector components: averaging 350° and 010° as numbers
 * gives 180°, the opposite of the right answer.
 */
export function interpolateWindAtLevel(
  snapshot: WeatherSnapshot,
  level: WeatherLevel,
  lat: number,
  lon: number,
): Wind | null {
  const fields = fieldsAt(snapshot, level);
  if (!fields) return null;
  const cell = locate(snapshot.grid, lat, lon);
  if (!cell) return null;

  const { nlon } = snapshot.grid;
  const corners = [
    windAtPoint(fields, cell.r0 * nlon + cell.c0),
    windAtPoint(fields, cell.r0 * nlon + cell.c1),
    windAtPoint(fields, cell.r1 * nlon + cell.c0),
    windAtPoint(fields, cell.r1 * nlon + cell.c1),
  ];
  if (corners.some((w) => w === null)) return null;

  const [[u00, v00], [u01, v01], [u10, v10], [u11, v11]] = corners.map((w) => toUV(w!));
  const u = lerp(lerp(u00, u01, cell.fc), lerp(u10, u11, cell.fc), cell.fr);
  const v = lerp(lerp(v00, v01, cell.fc), lerp(v10, v11, cell.fc), cell.fr);
  return fromUV(u, v);
}

/**
 * Wind at a position and pressure altitude: horizontal interpolation on the
 * two levels bracketing the aircraft's pressure, then linear in ln(p) between
 * them. The surface counts as a level at 1013.25 hPa.
 */
export function interpolateWind(
  snapshot: WeatherSnapshot,
  lat: number,
  lon: number,
  altitudeFt: number,
): Wind | null {
  if (!Number.isFinite(altitudeFt)) return null;
  const p = pressureAltitudeToHpa(altitudeFt);

  // The column from the ground up: the surface, then each pressure level.
  const column: { hpa: number; level: WeatherLevel }[] = [
    { hpa: ISA_SEA_LEVEL_HPA, level: "surface" },
    ...availableLevels(snapshot)
      .filter((l) => l < ISA_SEA_LEVEL_HPA)
      .map((l) => ({ hpa: l, level: l as WeatherLevel })),
  ];

  if (p >= column[0].hpa) return interpolateWindAtLevel(snapshot, "surface", lat, lon);

  const top = column[column.length - 1];
  if (p <= top.hpa) {
    // Hold the top level's wind a little above it -- but never the surface's:
    // a column with no pressure levels has nothing to say about cruise winds.
    if (top.level === "surface" || p < TOP_LEVEL_HOLD_HPA) return null;
    return interpolateWindAtLevel(snapshot, top.level, lat, lon);
  }

  for (let i = 0; i < column.length - 1; i++) {
    const lower = column[i];
    const upper = column[i + 1];
    if (p <= lower.hpa && p >= upper.hpa) {
      const a = interpolateWindAtLevel(snapshot, lower.level, lat, lon);
      const b = interpolateWindAtLevel(snapshot, upper.level, lat, lon);
      if (!a || !b) return null;
      const t = (Math.log(lower.hpa) - Math.log(p)) / (Math.log(lower.hpa) - Math.log(upper.hpa));
      const [ua, va] = toUV(a);
      const [ub, vb] = toUV(b);
      return fromUV(lerp(ua, ub, t), lerp(va, vb, t));
    }
  }
  return null;
}

/** Head/tail and crosswind components of `wind` for an aircraft on `trackDeg`. */
export function windComponents(wind: Wind, trackDeg: number): WindComponents {
  const relative = (wind.dirDeg - trackDeg) * DEG;
  return {
    headwindKt: wind.speedKt * Math.cos(relative),
    crosswindKt: wind.speedKt * Math.sin(relative),
  };
}

/** Barb elements for a speed, rounded to the nearest 5 kt. */
export function barbParts(speedKt: number): BarbParts {
  const calm: BarbParts = { pennants: 0, full: 0, half: 0, calm: true };
  if (!Number.isFinite(speedKt)) return calm;
  const rounded = Math.round(speedKt / 5) * 5;
  if (rounded < 5) return calm;
  const pennants = Math.floor(rounded / 50);
  const rest = rounded - pennants * 50;
  return { pennants, full: Math.floor(rest / 10), half: rest % 10 >= 5 ? 1 : 0, calm: false };
}

/** Whether the snapshot's valid time is older than `staleAfterMs`. */
export function isStale(
  snapshot: WeatherSnapshot,
  nowMs: number,
  staleAfterMs: number = STALE_AFTER_MS,
): boolean {
  return nowMs - snapshot.valid_time_ms > staleAfterMs;
}

/**
 * How far the valid time is from now, for the layer's status line:
 * `"valid now"`, `"valid 35 min ago"`, `"valid in 28 min"`, `"valid 4 h ago"`.
 *
 * The valid time can be ahead of now: the service picks the nearest model hour,
 * which is a short forecast for the second half of every hour.
 */
export function describeValidity(validTimeMs: number, nowMs: number): string {
  const minutes = Math.round((nowMs - validTimeMs) / 60_000);
  const magnitude = Math.abs(minutes);
  if (magnitude < 1) return "valid now";
  const span = magnitude < 90 ? `${magnitude} min` : `${Math.round(magnitude / 60)} h`;
  return minutes > 0 ? `valid ${span} ago` : `valid in ${span}`;
}

/** `"now"`, `"in 25 min"`, `"in 6 h"`: relative, so it reads the same in every timezone. */
function describeWait(atMs: number, nowMs: number): string {
  const minutes = Math.round((atMs - nowMs) / 60_000);
  if (minutes < 1) return "now";
  return minutes < 90 ? `in ${minutes} min` : `in ${Math.round(minutes / 60)} h`;
}

const STATE_WORDS: Record<WeatherServiceState, string> = {
  idle: "up to date",
  fetching: "fetching",
  retrying: "retrying",
  rate_limited: "rate limited",
  rejected: "rejected",
  disabled: "paused",
};

const LIMIT_WORDS: Record<RateLimitScope, string> = {
  minutely: "per-minute",
  hourly: "hourly",
  daily: "daily",
  unknown: "request",
};

export type ServiceTone = "ok" | "warn" | "error";

export interface ServiceLine {
  text: string;
  tone: ServiceTone;
}

/**
 * One line saying what the weather service is doing, or null when nothing has
 * been heard from it. Built only from what the service published: the desktop
 * never guesses at its schedule.
 *
 * Every line names who acts -- the service, or Open-Meteo. The desktop fetches
 * nothing itself; it hears the service over MQTT, so a bare "Fetching paused"
 * would read as if the app had stopped receiving.
 */
export function describeServiceStatus(view: WeatherServiceView, nowMs: number): ServiceLine | null {
  const { status, availability } = view;
  if (availability === "offline") {
    return {
      text: status
        ? `Weather service offline (was ${STATE_WORDS[status.state]})`
        : "Weather service offline",
      tone: "error",
    };
  }
  if (!status) return null;

  const next = status.next_fetch_ms != null ? describeWait(status.next_fetch_ms, nowMs) : null;
  switch (status.state) {
    case "disabled":
      return {
        text: "Service paused: not fetching from Open-Meteo · map keeps its last grid",
        tone: "warn",
      };
    case "fetching":
      return { text: "Service fetching from Open-Meteo…", tone: "ok" };
    case "idle":
      return {
        text: next ? `Service up to date · next Open-Meteo fetch ${next}` : "Service up to date",
        tone: "ok",
      };
    case "retrying":
      return {
        text: `Open-Meteo fetch failing (${status.consecutive_failures}×)${
          next ? ` · service retries ${next}` : ""
        }`,
        tone: "warn",
      };
    case "rate_limited":
      return {
        text: `Open-Meteo ${LIMIT_WORDS[status.rate_limit ?? "unknown"]} limit reached${
          next ? ` · service retries ${next}` : ""
        }`,
        tone: "warn",
      };
    case "rejected":
      return {
        text: `Open-Meteo rejected the service's request: ${status.last_error ?? "no reason given"}`,
        tone: "error",
      };
  }
}

export interface ServiceToggleView {
  checked: boolean;
  disabled: boolean;
  /** A setting was sent and the service has not reported it yet. */
  pending: boolean;
  /** Why the switch cannot be used, when that is not already on screen. */
  reason: string | null;
}

/**
 * The "Fetch weather" switch.
 *
 * Checked follows the service's reported setting, or the requested one while
 * a command is pending -- so the switch moves at once, but settles only when
 * the service says so. It cannot be used without a status to act on, or while
 * the service is offline, or while a command is still pending.
 */
export function serviceToggleView(
  availability: WeatherAvailability,
  view: WeatherServiceView,
  pendingEnabled: boolean | null,
): ServiceToggleView {
  if (availability === "unsupported_source") {
    return { checked: false, disabled: true, pending: false, reason: null };
  }
  const { status } = view;
  if (!status) {
    return {
      checked: false,
      disabled: true,
      pending: false,
      reason: "No status from the weather service yet",
    };
  }
  if (view.availability === "offline") {
    return { checked: status.enabled, disabled: true, pending: false, reason: null };
  }
  const pending = pendingEnabled !== null && pendingEnabled !== status.enabled;
  return {
    checked: pending ? (pendingEnabled as boolean) : status.enabled,
    disabled: pending,
    pending,
    reason: null,
  };
}

/**
 * A level as a person or a model writes it -- `"surface"`, `"SFC"`, `"250"`,
 * `"250 hPa"`, `"FL340"` -- resolved against the levels a snapshot carries.
 * A flight level maps to the nearest carried level; a pressure level must be
 * carried exactly. The error names every valid option, so a chat model can
 * correct itself.
 */
export function resolveWeatherLevel(
  input: string,
  levels: number[],
): { level: WeatherLevel } | { error: string } {
  const text = input.trim().toLowerCase().replace(/\s+/g, "");
  const options = ["SFC", ...levels.map((l) => levelLabel(l))].join(", ");
  if (text === "surface" || text === "sfc") return { level: "surface" };

  const fl = /^fl(\d{1,3})$/.exec(text);
  if (fl) {
    if (levels.length === 0) return { error: `No pressure levels are available. Options: ${options}.` };
    const target = Number(fl[1]);
    const nearest = levels.reduce((best, l) =>
      Math.abs(hpaToFlightLevel(l) - target) < Math.abs(hpaToFlightLevel(best) - target) ? l : best,
    );
    return { level: nearest };
  }

  const hpa = /^(\d{2,4})(hpa)?$/.exec(text);
  if (hpa && levels.includes(Number(hpa[1]))) return { level: Number(hpa[1]) };
  return { error: `Unknown or unavailable level "${input}". Options: ${options}.` };
}

export interface WindQuery {
  lat: number;
  lon: number;
  /** Pressure altitude, ft. Takes precedence over `level`. */
  altitudeFt?: number | null;
  /** Level to read when no altitude is given. Defaults to the surface. */
  level?: WeatherLevel;
  /** Track over the ground, degrees true: adds head and crosswind components. */
  trackDeg?: number | null;
}

/** Wind at a point, rounded for reading out -- the shape the chat tool returns. */
export interface WindReport {
  /** Direction the wind blows FROM, whole degrees true. */
  fromDeg: number;
  speedKt: number;
  /** Set when read on a level. */
  level?: string;
  /** Set when read at an altitude. */
  altitudeFt?: number;
  pressureHpa?: number;
  headwindKt?: number;
  crosswindKt?: number;
  validity: string;
  stale: boolean;
}

/** Rounds, and turns -0 into 0 so a JSON reader never sees "-0". */
function roundInt(value: number): number {
  return Math.round(value) || 0;
}

/** The wind at a position, on a level or at an altitude, for display or chat. */
export function windReport(
  snapshot: WeatherSnapshot,
  query: WindQuery,
  nowMs: number,
): WindReport | { error: string } {
  const { lat, lon, trackDeg } = query;
  const altitudeFt = query.altitudeFt != null && Number.isFinite(query.altitudeFt) ? query.altitudeFt : null;
  const level = query.level ?? "surface";

  if (altitudeFt === null && !fieldsAt(snapshot, level)) {
    return { error: `The snapshot has no ${levelLabel(level)} level.` };
  }
  const wind =
    altitudeFt !== null
      ? interpolateWind(snapshot, lat, lon, altitudeFt)
      : interpolateWindAtLevel(snapshot, level, lat, lon);
  if (!wind) {
    return { error: "No wind data there: the position is outside the weather grid, or the model has a gap." };
  }

  const report: WindReport = {
    fromDeg: roundInt(wind.dirDeg) % 360,
    speedKt: roundInt(wind.speedKt),
    ...(altitudeFt !== null
      ? { altitudeFt: roundInt(altitudeFt), pressureHpa: roundInt(pressureAltitudeToHpa(altitudeFt)) }
      : { level: levelLabel(level) }),
    validity: describeValidity(snapshot.valid_time_ms, nowMs),
    stale: isStale(snapshot, nowMs),
  };
  if (trackDeg != null && Number.isFinite(trackDeg)) {
    const { headwindKt, crosswindKt } = windComponents(wind, trackDeg);
    report.headwindKt = roundInt(headwindKt);
    report.crosswindKt = roundInt(crosswindKt);
  }
  return report;
}

/**
 * OpenAIP airspaces: interpreting what `get_airspaces` returns.
 *
 * Rust fetches and caches OpenAIP's raw items per AIRAC cycle
 * (`src-tauri/src/airspace.rs`); everything about reading them lives here, as
 * pure functions, so it can move unchanged to another map engine.
 *
 * Codes follow OpenAIP's published schema
 * (api.core.openaip.net/api/schemas/response/airspace/airspace-schema.json):
 * `type` 0–36, `icaoClass` 0–6 for A–G and 8 for unclassified / special use,
 * limit `unit` 0 m, 1 ft, 6 FL, `referenceDatum` 0 GND, 1 MSL, 2 STD.
 */

/** Data licence, shown on the map while the layer is on. */
export const AIRSPACE_ATTRIBUTION = 'Airspaces © <a href="https://www.openaip.net">openAIP</a> (CC BY-NC-SA 4.0)';

export interface OpenAipLimit {
  value: number;
  unit: number;
  referenceDatum: number;
}

export interface AiracCycle {
  /** `YYNN`, e.g. "2611". */
  ident: string;
  /** ISO date the cycle takes effect. */
  effective: string;
  /** ISO date of the next cycle. */
  expires: string;
}

/** One country, as `get_airspaces` returns it. */
export interface CountryAirspaces {
  country: string;
  /** The data's cycle: an older one when `origin` is "stale-cache". */
  cycle: AiracCycle | null;
  /** The data's cycle is no longer in force. */
  expired: boolean;
  origin: "cache" | "download" | "stale-cache" | "none";
  /** Raw OpenAIP items, unvalidated. */
  items: unknown[];
  error: string | null;
}

/** An airspace ready to draw and to describe. */
export interface Airspace {
  /** Country-prefixed, since OpenAIP ids are only unique per collection. */
  id: string;
  name: string;
  type: number;
  typeLabel: string;
  icaoClass: number;
  /** "A"–"G", or null for unclassified / special-use airspace. */
  classLabel: string | null;
  lower: string;
  upper: string;
  /** Lower limit in feet, approximate (AGL taken as is): for ordering only. */
  lowerFt: number;
  /** The published limits, for comparing with an aircraft (`verticalStatus`). */
  lowerLimit: OpenAipLimit | null;
  upperLimit: OpenAipLimit | null;
  /** Outer ring as [lng, lat] pairs, closed. */
  ring: [number, number][];
  /** [west, south, east, north]. */
  bbox: [number, number, number, number];
  country: string;
}

const TYPE_LABELS: Record<number, string> = {
  0: "Other", 1: "Restricted", 2: "Danger", 3: "Prohibited", 4: "CTR", 5: "TMZ", 6: "RMZ",
  7: "TMA", 8: "TRA", 9: "TSA", 10: "FIR", 11: "UIR", 12: "ADIZ", 13: "ATZ", 14: "MATZ",
  15: "Airway", 16: "MTR", 17: "Alert", 18: "Warning", 19: "Protected", 20: "HTZ",
  21: "Gliding sector", 22: "TRP", 23: "TIZ", 24: "TIA", 25: "MTA", 26: "CTA", 27: "ACC sector",
  28: "Sport / recreation", 29: "Low overflight restriction", 30: "MRT", 31: "TFR",
  32: "VFR sector", 33: "FIS sector", 34: "LTA", 35: "UTA", 36: "MCTR",
};

const CLASS_LETTERS = ["A", "B", "C", "D", "E", "F", "G"];

/**
 * Types not drawn: regions and sectors that cover the whole map (FIR, UIR,
 * ACC, FIS, VFR sector, LTA, UTA) and routes, which are lines drawn as
 * corridors (airways, MTR, MRT, TFR).
 */
const HIDDEN_TYPES = new Set([10, 11, 15, 16, 27, 30, 31, 32, 33, 34, 35]);

const FT_PER_M = 3.28084;
const DATUM_SUFFIX: Record<number, string> = { 0: " AGL", 1: "", 2: " STD" };

export function formatLimit(l: OpenAipLimit): string {
  if (l.unit === 6) return `FL${l.value}`;
  if (l.referenceDatum === 0 && l.value === 0) return "GND";
  const unit = l.unit === 0 ? "m" : "ft";
  return `${l.value} ${unit}${DATUM_SUFFIX[l.referenceDatum] ?? ""}`;
}

export function limitFeet(l: OpenAipLimit): number {
  if (l.unit === 6) return l.value * 100;
  if (l.unit === 0) return l.value * FT_PER_M;
  return l.value;
}

function isLimit(v: unknown): v is OpenAipLimit {
  const l = v as OpenAipLimit | null;
  return !!l && typeof l.value === "number" && typeof l.unit === "number" && typeof l.referenceDatum === "number";
}

function readRing(geometry: unknown): [number, number][] | null {
  const g = geometry as { type?: string; coordinates?: unknown } | null;
  if (!g || g.type !== "Polygon" || !Array.isArray(g.coordinates)) return null;
  const ring = g.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const out: [number, number][] = [];
  for (const p of ring) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    out.push([p[0], p[1]]);
  }
  return out;
}

function ringBbox(ring: [number, number][]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of ring) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** A raw OpenAIP item → `Airspace`, or null when it has no usable polygon. */
export function normalizeAirspace(raw: unknown, country: string): Airspace | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ring = readRing(r.geometry);
  if (!ring) return null;
  const type = typeof r.type === "number" ? r.type : 0;
  const icaoClass = typeof r.icaoClass === "number" ? r.icaoClass : 8;
  const lower = isLimit(r.lowerLimit) ? r.lowerLimit : null;
  const upper = isLimit(r.upperLimit) ? r.upperLimit : null;
  return {
    id: `${country}:${String(r._id ?? r.name ?? "")}`,
    name: typeof r.name === "string" && r.name.trim() ? r.name : "(unnamed)",
    type,
    typeLabel: TYPE_LABELS[type] ?? `Type ${type}`,
    icaoClass,
    classLabel: CLASS_LETTERS[icaoClass] ?? null,
    lower: lower ? formatLimit(lower) : "?",
    upper: upper ? formatLimit(upper) : "?",
    lowerFt: lower ? limitFeet(lower) : 0,
    lowerLimit: lower,
    upperLimit: upper,
    ring,
    bbox: ringBbox(ring),
    country,
  };
}

/**
 * Everything drawable, from every country: hidden types dropped, and, given a
 * centre, only airspaces whose bbox comes within `radiusNm` of it. The API
 * can only filter by country, so this is where a receiver's surroundings are
 * cut out of a whole country.
 */
export function prepareAirspaces(
  countries: CountryAirspaces[],
  center?: { lat: number; lng: number } | null,
  radiusNm = 300,
): Airspace[] {
  let box: [number, number, number, number] | null = null;
  if (center) {
    const dLat = radiusNm / 60;
    const dLng = dLat / Math.max(Math.cos((center.lat * Math.PI) / 180), 0.01);
    box = [center.lng - dLng, center.lat - dLat, center.lng + dLng, center.lat + dLat];
  }
  const out: Airspace[] = [];
  for (const c of countries) {
    for (const raw of c.items) {
      const a = normalizeAirspace(raw, c.country);
      if (!a || HIDDEN_TYPES.has(a.type)) continue;
      if (box && (a.bbox[2] < box[0] || a.bbox[0] > box[2] || a.bbox[3] < box[1] || a.bbox[1] > box[3])) continue;
      out.push(a);
    }
  }
  return out;
}

export interface AirspaceTypeCount {
  type: number;
  label: string;
  count: number;
}

/** The types present in `list`, with counts, sorted by label: the type filter's options. */
export function airspaceTypes(list: Airspace[]): AirspaceTypeCount[] {
  const byType = new Map<number, AirspaceTypeCount>();
  for (const a of list) {
    const t = byType.get(a.type);
    if (t) t.count++;
    else byType.set(a.type, { type: a.type, label: a.typeLabel, count: 1 });
  }
  return [...byType.values()].sort((x, y) => x.label.localeCompare(y.label));
}

/** `list` without the hidden types; the same array when nothing is hidden. */
export function filterByType(list: Airspace[], hidden: readonly number[]): Airspace[] {
  if (hidden.length === 0) return list;
  const h = new Set(hidden);
  return list.filter((a) => !h.has(a.type));
}

/** An aircraft's height, both ways: what it reports, and corrected with QNH when known. */
export interface AircraftHeights {
  /** ADS-B barometric altitude, referenced to 1013.25 hPa. */
  pressureFt: number | null;
  /** Altimeter altitude with the nearest station's QNH; null without one. */
  mslFt: number | null;
}

export type VerticalStatusKind = "inside" | "below" | "above" | "unknown";

export interface VerticalStatus {
  status: VerticalStatusKind;
  /** A limit in feet MSL decided it, but no QNH was available: compared with pressure altitude. */
  approximate: boolean;
}

type Side = { ok: boolean | null; approximate: boolean };

/**
 * One limit against the aircraft. Each limit is compared in its own reference:
 * flight levels and STD with pressure altitude, MSL with the QNH altitude (or
 * pressure altitude, flagged, without one). GND is always satisfied as a lower
 * limit; other heights above ground stay unknown until there is terrain.
 */
function side(limit: OpenAipLimit | null, kind: "lower" | "upper", h: AircraftHeights): Side {
  const unknown = { ok: null, approximate: false };
  if (!limit || h.pressureFt == null) return unknown;
  const cmp = (alt: number, ft: number) => (kind === "lower" ? alt >= ft : alt <= ft);
  if (limit.unit === 6) return { ok: cmp(h.pressureFt, limit.value * 100), approximate: false };
  const ft = limit.unit === 0 ? limit.value * FT_PER_M : limit.value;
  if (limit.referenceDatum === 2) return { ok: cmp(h.pressureFt, ft), approximate: false };
  if (limit.referenceDatum === 0) return kind === "lower" && limit.value === 0 ? { ok: true, approximate: false } : unknown;
  return { ok: cmp(h.mslFt ?? h.pressureFt, ft), approximate: h.mslFt == null };
}

/** Whether an aircraft is inside, below or above an airspace's vertical extent. */
export function verticalStatus(a: Airspace, h: AircraftHeights): VerticalStatus {
  const lower = side(a.lowerLimit, "lower", h);
  const upper = side(a.upperLimit, "upper", h);
  if (lower.ok === false) return { status: "below", approximate: lower.approximate };
  if (upper.ok === false) return { status: "above", approximate: upper.approximate };
  if (lower.ok && upper.ok) return { status: "inside", approximate: lower.approximate || upper.approximate };
  return { status: "unknown", approximate: false };
}

/** Ray casting on [lng, lat] pairs. Fine at airspace scale, away from the poles and the antimeridian. */
function inRing(lng: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Every airspace containing the point, lowest first: the stack a pilot would read. */
export function airspacesAt(list: Airspace[], lat: number, lng: number): Airspace[] {
  return list
    .filter((a) => lng >= a.bbox[0] && lng <= a.bbox[2] && lat >= a.bbox[1] && lat <= a.bbox[3] && inRing(lng, lat, a.ring))
    .sort((a, b) => a.lowerFt - b.lowerFt || a.name.localeCompare(b.name));
}

export interface AirspaceStyle {
  color: string;
  weight: number;
  /** Outline opacity. */
  opacity: number;
  fillOpacity: number;
  dashArray?: string;
}

/** Opacity setting a new install starts with (Filters → Airspaces slider). */
export const DEFAULT_AIRSPACE_OPACITY = 0.4;

export interface AirspaceStyleOptions {
  /** The slider, 0–1: scales outlines and fills together. */
  opacity?: number;
  theme?: "light" | "dark";
}

/** Outlines never vanish entirely: at 0 the slider means "no fill", not "no airspace". */
const MIN_OUTLINE = 0.15;
/**
 * Night factors. The same fill reads far stronger over a dark basemap, where
 * it lightens the map, than over a light one, where it barely tints it.
 */
const DARK_FILL = 0.5;
const DARK_OUTLINE = 0.75;

const RED = "#ef4444";
const ORANGE = "#f97316";
const YELLOW = "#eab308";
const CLASS_COLORS: Record<number, string> = {
  0: "#a855f7", // A
  1: "#8b5cf6", // B
  2: "#6366f1", // C
  3: "#3b82f6", // D
  4: "#14b8a6", // E
  5: "#94a3b8", // F
  6: "#94a3b8", // G
};

/**
 * Restrictions by hazard, everything else by class; uncontrolled classes
 * dashed. Fill strengths are given at full opacity and scaled by the setting.
 */
export function airspaceStyle(a: Airspace, options: AirspaceStyleOptions = {}): AirspaceStyle {
  const o = Math.min(1, Math.max(0, options.opacity ?? DEFAULT_AIRSPACE_OPACITY));
  const dark = options.theme === "dark";
  const fill = (full: number) => full * o * (dark ? DARK_FILL : 1);
  const opacity = Math.max(MIN_OUTLINE, o) * (dark ? DARK_OUTLINE : 1);

  if (a.type === 1 || a.type === 3) return { color: RED, weight: 1.5, opacity, fillOpacity: fill(0.16) };
  if (a.type === 2 || a.type === 17 || a.type === 18) return { color: ORANGE, weight: 1.2, opacity, fillOpacity: fill(0.1) };
  if (a.type === 8 || a.type === 9 || a.type === 25) {
    return { color: YELLOW, weight: 1.2, opacity, fillOpacity: fill(0.1), dashArray: "6 4" };
  }
  const color = CLASS_COLORS[a.icaoClass] ?? "#64748b";
  const uncontrolled = a.icaoClass >= 4 && a.icaoClass <= 6;
  return uncontrolled
    ? { color, weight: 1.2, opacity, fillOpacity: fill(0.06), dashArray: "4 4" }
    : { color, weight: 1.2, opacity, fillOpacity: fill(0.1) };
}

export interface AirspaceStatus {
  /** Distinct cycles of the data shown, oldest first. */
  cycles: string[];
  /** Some data's cycle is no longer in force. */
  expired: boolean;
  /** "CC: message", per country that could not get the current cycle. */
  errors: string[];
}

export function airspaceStatus(countries: CountryAirspaces[]): AirspaceStatus {
  const cycles = [...new Set(countries.flatMap((c) => (c.cycle ? [c.cycle.ident] : [])))].sort();
  return {
    cycles,
    expired: countries.some((c) => c.expired),
    errors: countries.flatMap((c) => (c.error ? [`${c.country}: ${c.error}`] : [])),
  };
}

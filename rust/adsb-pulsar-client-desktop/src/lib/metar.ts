/**
 * METAR reports: interpreting what `get_metars` returns.
 *
 * Rust fetches the latest report per station from AviationWeather.gov and
 * keeps the last snapshot in memory (`src-tauri/src/metar.rs`). Everything
 * about reading the items lives here, as pure functions, like `airspace.ts`.
 * Field shapes were checked against the live API on 2026-11-19: `wdir` is a
 * number or "VRB", `visib` a number or a string such as "10+", `fltCat` null
 * when a station reports no visibility, `altim` is QNH in hPa.
 */

export const METAR_ATTRIBUTION = 'METAR <a href="https://aviationweather.gov">AviationWeather.gov</a> (NOAA)';

export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR";
/** A category key for filtering: a flight category, or "unknown" when none is reported. */
export type CategoryKey = FlightCategory | "unknown";

const CATEGORIES: FlightCategory[] = ["VFR", "MVFR", "IFR", "LIFR"];

/** One snapshot, as `get_metars` returns it. */
export interface MetarSnapshot {
  items: unknown[];
  /** When Rust downloaded the items, epoch ms. */
  fetchedAtMs: number | null;
  origin: "cache" | "download" | "stale-cache" | "none";
  error: string | null;
}

export interface CloudLayer {
  cover: string;
  base: number | null;
}

export interface Metar {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: FlightCategory | null;
  obsTimeMs: number;
  speci: boolean;
  raw: string;
  tempC: number | null;
  dewpC: number | null;
  /** QNH, hPa: what pressure altitude needs to become altitude above MSL. */
  qnhHpa: number | null;
  wind: string | null;
  visibility: string | null;
  clouds: string | null;
  weather: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function formatWind(dir: unknown, speed: unknown, gust: unknown): string | null {
  const s = num(speed);
  if (s == null) return null;
  if (s === 0) return "Calm";
  const g = num(gust);
  const d = dir === "VRB" ? "VRB" : num(dir) != null ? `${String(num(dir)).padStart(3, "0")}°` : "---";
  return `${d} ${s}${g != null ? `G${g}` : ""} kt`;
}

export function formatVisibility(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return `${v} SM`;
  const n = num(v);
  return n != null ? `${n} SM` : null;
}

export function formatClouds(clouds: unknown, cover: unknown): string | null {
  if (Array.isArray(clouds) && clouds.length > 0) {
    return clouds
      .map((c: { cover?: unknown; base?: unknown }) => {
        const base = num(c?.base);
        return `${str(c?.cover) ?? "?"}${base != null ? ` ${base} ft` : ""}`;
      })
      .join(", ");
  }
  return str(cover);
}

/** A raw AviationWeather.gov item → `Metar`, or null without an id or a position. */
export function normalizeMetar(item: unknown): Metar | null {
  if (!item || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  const id = str(r.icaoId);
  const lat = num(r.lat);
  const lng = num(r.lon);
  if (!id || lat == null || lng == null) return null;
  const cat = str(r.fltCat);
  return {
    id,
    name: str(r.name) ?? id,
    lat,
    lng,
    category: cat && (CATEGORIES as string[]).includes(cat) ? (cat as FlightCategory) : null,
    obsTimeMs: (num(r.obsTime) ?? 0) * 1000,
    speci: r.metarType === "SPECI",
    raw: str(r.rawOb) ?? "",
    tempC: num(r.temp),
    dewpC: num(r.dewp),
    qnhHpa: num(r.altim),
    wind: formatWind(r.wdir, r.wspd, r.wgst),
    visibility: formatVisibility(r.visib),
    clouds: formatClouds(r.clouds, r.cover),
    weather: str(r.wxString),
  };
}

export function prepareMetars(items: unknown[]): Metar[] {
  const out: Metar[] = [];
  for (const i of items) {
    const x = normalizeMetar(i);
    if (x) out.push(x);
  }
  return out;
}

/** Reports older than this are drawn hollow and flagged: a METAR is hourly. */
export const OLD_MINUTES = 90;

export const ageMinutes = (obsTimeMs: number, nowMs: number) => Math.max(0, Math.floor((nowMs - obsTimeMs) / 60_000));
export const isOld = (minutes: number) => minutes > OLD_MINUTES;

export function formatAge(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}

/** The usual aviation chart colours. */
const CATEGORY_COLORS: Record<FlightCategory, string> = {
  VFR: "#22c55e",
  MVFR: "#3b82f6",
  IFR: "#ef4444",
  LIFR: "#d946ef",
};
const UNKNOWN_COLOR = "#94a3b8";

export const metarColor = (c: FlightCategory | null) => (c ? CATEGORY_COLORS[c] : UNKNOWN_COLOR);

export const DEFAULT_METAR_OPACITY = 0.8;

export interface MetarMarkerStyle {
  radius: number;
  color: string;
  weight: number;
  opacity: number;
  fillColor: string;
  fillOpacity: number;
}

/**
 * A station dot. The slider scales it like the airspace one (an outline
 * survives at 0); night dims it; an old report keeps its colour as a ring but
 * loses most of its fill, so it reads as "was", not "is".
 */
export function metarMarkerStyle(
  x: Metar,
  options: { opacity?: number; theme?: "light" | "dark"; nowMs: number },
): MetarMarkerStyle {
  const o = Math.min(1, Math.max(0, options.opacity ?? DEFAULT_METAR_OPACITY));
  const dark = options.theme === "dark";
  const colour = metarColor(x.category);
  const old = isOld(ageMinutes(x.obsTimeMs, options.nowMs));
  const fill = o * (dark ? 0.75 : 1) * (old ? 0.2 : 1);
  return {
    radius: 6,
    color: colour,
    weight: 1.5,
    opacity: Math.max(0.2, o) * (dark ? 0.85 : 1),
    fillColor: colour,
    fillOpacity: fill,
  };
}

export interface CategoryCount {
  value: CategoryKey;
  label: string;
  count: number;
}

const keyOf = (x: Metar): CategoryKey => x.category ?? "unknown";

/** The categories present, with counts, in severity order: the filter's options. */
export function metarCategories(list: Metar[]): CategoryCount[] {
  const counts = new Map<CategoryKey, number>();
  for (const x of list) counts.set(keyOf(x), (counts.get(keyOf(x)) ?? 0) + 1);
  return ([...CATEGORIES, "unknown"] as CategoryKey[])
    .filter((k) => counts.has(k))
    .map((k) => ({ value: k, label: k === "unknown" ? "Unknown" : k, count: counts.get(k)! }));
}

/** `list` without the hidden categories; the same array when nothing is hidden. */
export function filterByCategory(list: Metar[], hidden: readonly CategoryKey[]): Metar[] {
  if (hidden.length === 0) return list;
  const h = new Set(hidden);
  return list.filter((x) => !h.has(keyOf(x)));
}

/** The station nearest the cursor within `maxPx`, given a projection to screen pixels. */
export function nearestMetar(
  list: Metar[],
  cursor: { x: number; y: number },
  project: (x: Metar) => { x: number; y: number },
  maxPx: number,
): Metar | null {
  let best: Metar | null = null;
  let bestD = maxPx * maxPx;
  for (const x of list) {
    const p = project(x);
    const d = (p.x - cursor.x) ** 2 + (p.y - cursor.y) ** 2;
    if (d <= bestD) {
      best = x;
      bestD = d;
    }
  }
  return best;
}

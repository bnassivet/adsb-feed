/**
 * Seamark descriptions for the tooltip. The OpenSeaMap tiles are images; the
 * text comes from OpenStreetMap tags, fetched by Rust from Overpass per 2° cell
 * and cached for a week (`src-tauri/src/seamarks.rs`). Tags are user-edited
 * text: they are only ever shown with `textContent`, never as HTML.
 */
import { SEAMARK_MIN_ZOOM } from "./sea";

export interface Seamark {
  id: string;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

export interface SeamarkSnapshot {
  items: Seamark[];
  stale: boolean;
  error: string | null;
}

/** Mirrors `seamarks::CELL_DEG` and `MAX_CELLS`. */
const CELL_DEG = 2;
const MAX_CELLS = 6;

const cellName = (lat: number, lon: number) =>
  `${lat < 0 ? "S" : "N"}${String(Math.abs(lat)).padStart(2, "0")}${lon < 0 ? "W" : "E"}${String(Math.abs(lon)).padStart(3, "0")}`;

/**
 * The 2° cells under a view, as Rust's `cells_for` lists them, joined: a new
 * request is needed only when this changes. Null below the seamark zoom or
 * when the view is too wide.
 */
export function seamarkCellsKey(
  b: { south: number; west: number; north: number; east: number },
  zoom: number,
): string | null {
  if (zoom < SEAMARK_MIN_ZOOM) return null;
  const floor = (d: number) => Math.floor(d / CELL_DEG) * CELL_DEG;
  const [s, n] = [floor(Math.max(b.south, -90)), floor(Math.min(b.north, 89.999))];
  const [w, e] = [floor(Math.max(b.west, -180)), floor(Math.min(b.east, 179.999))];
  if (((n - s) / CELL_DEG + 1) * ((e - w) / CELL_DEG + 1) > MAX_CELLS) return null;
  const names: string[] = [];
  for (let lat = s; lat <= n; lat += CELL_DEG) for (let lon = w; lon <= e; lon += CELL_DEG) names.push(cellName(lat, lon));
  return names.join(",");
}

/** Kept off the cell edges, so Rust's floor() lands in the same cells. */
const INSET = 0.01;

/** A box inside the cells of a key, for `get_seamarks`; null for a bad key. */
export function cellsBounds(key: string): { south: number; west: number; north: number; east: number } | null {
  const cells = key.split(",").map((name) => /^([NS])(\d{2})([EW])(\d{3})$/.exec(name));
  if (cells.length === 0 || cells.some((m) => !m)) return null;
  const lats = cells.map((m) => (m![1] === "S" ? -1 : 1) * Number(m![2]));
  const lons = cells.map((m) => (m![3] === "W" ? -1 : 1) * Number(m![4]));
  return {
    south: Math.min(...lats) + INSET,
    west: Math.min(...lons) + INSET,
    north: Math.max(...lats) + CELL_DEG - INSET,
    east: Math.max(...lons) + CELL_DEG - INSET,
  };
}

/** Plain names for the common `seamark:type` values; others are humanized. */
const TYPE_NAMES: Record<string, string> = {
  buoy_lateral: "Lateral buoy",
  buoy_cardinal: "Cardinal buoy",
  buoy_isolated_danger: "Isolated danger buoy",
  buoy_safe_water: "Safe water buoy",
  buoy_special_purpose: "Special purpose buoy",
  buoy_installation: "Installation buoy",
  beacon_lateral: "Lateral beacon",
  beacon_cardinal: "Cardinal beacon",
  beacon_isolated_danger: "Isolated danger beacon",
  beacon_safe_water: "Safe water beacon",
  beacon_special_purpose: "Special purpose beacon",
  light_major: "Major light",
  light_minor: "Minor light",
  light_vessel: "Light vessel",
  light_float: "Light float",
  landmark: "Landmark",
  harbour: "Harbour",
  small_craft_facility: "Small craft facility",
  anchorage: "Anchorage",
  anchor_berth: "Anchor berth",
  mooring: "Mooring",
  wreck: "Wreck",
  rock: "Rock",
  obstruction: "Obstruction",
  crane: "Crane",
  pile: "Pile",
  platform: "Platform",
  bridge: "Bridge",
  cable_submarine: "Submarine cable",
  pipeline_submarine: "Submarine pipeline",
  fog_signal: "Fog signal",
  radar_transponder: "Radar transponder",
  restricted_area: "Restricted area",
  separation_zone: "Traffic separation zone",
};

const humanize = (v: string) => {
  const s = v.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const words = (v: string) => v.replace(/_/g, " ");
/** `red;white` → `red and white`. */
const colours = (v: string) => v.split(";").map(words).join(" and ");

const LIGHT_COLOURS: Record<string, string> = {
  white: "W", red: "R", green: "G", yellow: "Y", blue: "Bu", orange: "Or", violet: "Vi", amber: "Am",
};

function oneLight(tags: Record<string, string>, prefix: string): string | null {
  const character = tags[`${prefix}character`];
  if (!character) return null;
  const group = tags[`${prefix}group`];
  const colour = tags[`${prefix}colour`];
  const period = tags[`${prefix}period`];
  const range = tags[`${prefix}range`];
  const parts = [group ? `${character}(${group})` : character];
  if (colour) parts.push(colour.split(";").map((c) => LIGHT_COLOURS[c] ?? c).join(""));
  if (period) parts.push(`${period}s`);
  if (range) parts.push(`${range}M`);
  return parts.join(" ");
}

/** The light as on a chart, e.g. `Fl(3) G 12s 5M`; sector lights give the first and a count. */
export function lightText(tags: Record<string, string>): string | null {
  const single = oneLight(tags, "seamark:light:");
  if (single) return single;
  const sectors = [...new Set(Object.keys(tags).map((k) => /^seamark:light:(\d+):character$/.exec(k)?.[1]).filter(Boolean))]
    .map(Number)
    .sort((a, b) => a - b);
  if (sectors.length === 0) return null;
  const first = oneLight(tags, `seamark:light:${sectors[0]}:`);
  const more = sectors.length - 1;
  return more > 0 ? `${first} (+${more} sector${more > 1 ? "s" : ""})` : first;
}

const NOTE_MAX = 120;

/** A title and a few lines of plain text for the tooltip. */
export function describeSeamark(tags: Record<string, string>): { title: string; lines: string[] } {
  const type = tags["seamark:type"] ?? "";
  const kind = TYPE_NAMES[type] ?? humanize(type || "seamark");
  const name = tags["seamark:name"] ?? tags.name;
  const lines: string[] = [];
  const category = tags[`seamark:${type}:category`];
  const colour = tags[`seamark:${type}:colour`];
  const shape = tags[`seamark:${type}:shape`];
  const look = [colour && colours(colour), shape && words(shape)].filter(Boolean).join(", ");
  const head = [kind, category && words(category), look || null].filter(Boolean);
  // A lone kind under a title that already is the kind says nothing.
  if (name || head.length > 1) lines.push(head.join(" · "));
  const light = lightText(tags);
  if (light) lines.push(`Light ${light}`);
  const topShape = tags["seamark:topmark:shape"];
  const topColour = tags["seamark:topmark:colour"];
  if (topShape) lines.push(`Topmark ${[topShape, topColour && colours(topColour)].filter(Boolean).join(", ")}`);
  const note = tags["seamark:information"];
  if (note) lines.push(note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX)}…` : note);
  return { title: name ?? kind, lines };
}

/** The seamark nearest a screen point, within `maxPx`. */
export function nearestSeamark(
  items: Seamark[],
  at: { x: number; y: number },
  project: (s: Seamark) => { x: number; y: number },
  maxPx: number,
): Seamark | null {
  let best: Seamark | null = null;
  let bestD = maxPx * maxPx;
  for (const s of items) {
    const p = project(s);
    const d = (p.x - at.x) ** 2 + (p.y - at.y) ** 2;
    if (d <= bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

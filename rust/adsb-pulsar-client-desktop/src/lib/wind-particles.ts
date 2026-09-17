/**
 * Animated wind particles: the field sampler and the particle simulation
 * behind the map's particle layer. Pure functions, no DOM and no Leaflet --
 * the layer in MapInner owns the canvas, the projection and the frame loop.
 *
 * Runs every animation frame for a couple of thousand particles, so the state
 * is struct-of-arrays and the hot path allocates nothing.
 */

import type { MapTheme } from "./colors";
import { fieldsAt, windAtPoint, type WeatherGrid, type WeatherLevel, type WeatherSnapshot } from "./weather";

export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** One level of a snapshot as wind vectors, ready to sample per frame. */
export interface WindField {
  grid: WeatherGrid;
  /** Eastward component, kt, row-major; NaN where the model had no value. */
  u: Float64Array;
  /** Northward component, kt. */
  v: Float64Array;
}

export interface Particles {
  count: number;
  lat: Float64Array;
  lon: Float64Array;
  /** Seconds since the particle was seeded. */
  age: Float32Array;
  /** Age at which it is re-seeded. */
  maxAge: Float32Array;
  /** Wind speed where it was last moved, kt -- selects its colour. */
  speedKt: Float32Array;
  /**
   * 1 where the particle was (re-)seeded this step. It has no previous screen
   * position, so the layer draws no segment for it -- otherwise a respawn
   * would streak a line across the map.
   */
  reborn: Uint8Array;
}

export interface StepOptions {
  /** Seconds since the previous frame. */
  dtS: number;
  /** Screen speed: pixels per second per knot of wind. */
  pxPerKtS: number;
  /** Degrees of longitude per screen pixel at the current zoom. */
  degPerPx: number;
}

/** A longer frame gap (a backgrounded tab resuming) is treated as this long. */
export const MAX_STEP_S = 0.1;
export const MIN_PARTICLE_AGE_S = 2;
export const MAX_PARTICLE_AGE_S = 5;
export const MIN_PARTICLES = 300;
export const MAX_PARTICLES = 2500;
/** Canvas pixels per particle. */
const PX_PER_PARTICLE = 800;

/** Upper edges of the colour buckets, kt. Six buckets: the last is open-ended. */
export const SPEED_BUCKETS_KT = [20, 40, 60, 80, 100] as const;

/**
 * Particle stroke colour per speed bucket, slowest first. Shared by the
 * particle layer and its legend, so the two cannot drift apart. Faster air is
 * also more opaque.
 */
export const PARTICLE_COLORS: Record<MapTheme, readonly string[]> = {
  dark: [
    "rgba(186, 230, 253, 0.45)",
    "rgba(125, 211, 252, 0.6)",
    "rgba(56, 189, 248, 0.75)",
    "rgba(250, 204, 21, 0.8)",
    "rgba(251, 146, 60, 0.85)",
    "rgba(244, 63, 94, 0.9)",
  ],
  light: [
    "rgba(71, 85, 105, 0.45)",
    "rgba(2, 132, 199, 0.6)",
    "rgba(3, 105, 161, 0.75)",
    "rgba(202, 138, 4, 0.8)",
    "rgba(234, 88, 12, 0.85)",
    "rgba(190, 18, 60, 0.9)",
  ],
};

const DEG = Math.PI / 180;
const GRID_EPS = 1e-9;

/**
 * Converts one level to u/v vectors once, so per-frame sampling is arithmetic
 * on typed arrays. Null when the snapshot does not carry the level.
 */
export function createWindField(snapshot: WeatherSnapshot, level: WeatherLevel): WindField | null {
  const fields = fieldsAt(snapshot, level);
  if (!fields) return null;
  const n = snapshot.grid.nlat * snapshot.grid.nlon;
  const u = new Float64Array(n);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const wind = windAtPoint(fields, i);
    if (!wind) {
      u[i] = NaN;
      v[i] = NaN;
      continue;
    }
    // The vector the air moves along: a wind FROM 270 blows east.
    const r = wind.dirDeg * DEG;
    u[i] = -wind.speedKt * Math.sin(r);
    v[i] = -wind.speedKt * Math.cos(r);
  }
  return { grid: snapshot.grid, u, v };
}

/**
 * Bilinear u/v at a position, written into `out` as `[u, v]`. False outside
 * the grid or where a corner of the cell is missing; `out` is then untouched.
 *
 * Same cell arithmetic as `interpolateWindAtLevel`, without its allocations.
 */
export function sampleWind(field: WindField, lat: number, lon: number, out: number[] | Float64Array): boolean {
  const { lat0, lon0, dlat, dlon, nlat, nlon } = field.grid;
  if (nlat < 1 || nlon < 1) return false;
  const r = (lat - lat0) / dlat;
  // Measured eastward from lon0, so a grid crossing the antimeridian works.
  const c = ((((lon - lon0) % 360) + 360) % 360) / dlon;
  if (!(r >= -GRID_EPS && r <= nlat - 1 + GRID_EPS && c <= nlon - 1 + GRID_EPS)) return false;

  const rr = Math.min(Math.max(r, 0), nlat - 1);
  const cc = Math.min(c, nlon - 1);
  const r0 = Math.floor(rr);
  const c0 = Math.floor(cc);
  const r1 = Math.min(r0 + 1, nlat - 1);
  const c1 = Math.min(c0 + 1, nlon - 1);
  const fr = rr - r0;
  const fc = cc - c0;

  const i00 = r0 * nlon + c0;
  const i01 = r0 * nlon + c1;
  const i10 = r1 * nlon + c0;
  const i11 = r1 * nlon + c1;
  const { u, v } = field;
  const u00 = u[i00], u01 = u[i01], u10 = u[i10], u11 = u[i11];
  const v00 = v[i00], v01 = v[i01], v10 = v[i10], v11 = v[i11];
  // NaN propagates through the sum, so one check covers all eight values.
  const su = u00 + u01 + u10 + u11 + v00 + v01 + v10 + v11;
  if (Number.isNaN(su)) return false;

  const top = 1 - fr;
  out[0] = (u00 * (1 - fc) + u01 * fc) * top + (u10 * (1 - fc) + u11 * fc) * fr;
  out[1] = (v00 * (1 - fc) + v01 * fc) * top + (v10 * (1 - fc) + v11 * fc) * fr;
  return true;
}

/** The area a grid covers, corner point to corner point. */
export function fieldBounds(grid: WeatherGrid): GeoBounds {
  return {
    south: grid.lat0,
    west: grid.lon0,
    north: grid.lat0 + (grid.nlat - 1) * grid.dlat,
    east: grid.lon0 + (grid.nlon - 1) * grid.dlon,
  };
}

/** The overlap of two bounds, or null when they do not overlap. */
export function intersectBounds(a: GeoBounds, b: GeoBounds): GeoBounds | null {
  const south = Math.max(a.south, b.south);
  const north = Math.min(a.north, b.north);
  const west = Math.max(a.west, b.west);
  const east = Math.min(a.east, b.east);
  if (south >= north || west >= east) return null;
  return { south, west, north, east };
}

/**
 * Degrees of longitude per screen pixel on a Web Mercator map with 256 px
 * tiles. A pixel spans `cos(lat)` times as many degrees of latitude.
 */
export function degreesPerPixel(zoom: number): number {
  return 360 / (256 * Math.pow(2, zoom));
}

/** Latitude where the Web Mercator world is square; Leaflet clamps to it too. */
const MAX_MERCATOR_LAT = 85.0511287798;

/**
 * Web Mercator world pixel of a position at a zoom (256 px tiles), written
 * into `out` as `[x, y]`, y growing southwards. Matches Leaflet's EPSG:3857
 * `map.project`, without allocating a LatLng and a Point per call -- the
 * particle layer projects every particle on every frame.
 */
export function projectMercator(lat: number, lon: number, zoom: number, out: number[] | Float64Array): void {
  const scale = 256 * Math.pow(2, zoom);
  const phi = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat)) * DEG;
  out[0] = ((lon + 180) / 360) * scale;
  out[1] = (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * scale;
}

/** How many particles a canvas of this CSS size should carry. */
export function particleCount(widthPx: number, heightPx: number): number {
  const n = Math.round((widthPx * heightPx) / PX_PER_PARTICLE);
  return Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, n));
}

/** Colour bucket for a speed: 0 below 20 kt, up to 5 at 100 kt and above. */
export function speedBucket(speedKt: number): number {
  let bucket = 0;
  while (bucket < SPEED_BUCKETS_KT.length && speedKt >= SPEED_BUCKETS_KT[bucket]) bucket++;
  return bucket;
}

/** A bucket's speed range for display, kt: `"<20"`, `"20–40"`, …, `"≥100"`. */
export function speedBucketLabel(bucket: number): string {
  const edges = SPEED_BUCKETS_KT;
  if (bucket <= 0) return `<${edges[0]}`;
  if (bucket >= edges.length) return `≥${edges[edges.length - 1]}`;
  return `${edges[bucket - 1]}–${edges[bucket]}`;
}

function seed(p: Particles, i: number, bounds: GeoBounds, random: () => number): void {
  p.lat[i] = bounds.south + random() * (bounds.north - bounds.south);
  p.lon[i] = bounds.west + random() * (bounds.east - bounds.west);
  p.maxAge[i] = MIN_PARTICLE_AGE_S + random() * (MAX_PARTICLE_AGE_S - MIN_PARTICLE_AGE_S);
  p.age[i] = 0;
  p.speedKt[i] = 0;
  p.reborn[i] = 1;
}

/** `count` particles scattered over `bounds`, at staggered ages. */
export function createParticles(
  count: number,
  bounds: GeoBounds,
  random: () => number = Math.random,
): Particles {
  const p: Particles = {
    count,
    lat: new Float64Array(count),
    lon: new Float64Array(count),
    age: new Float32Array(count),
    maxAge: new Float32Array(count),
    speedKt: new Float32Array(count),
    reborn: new Uint8Array(count),
  };
  for (let i = 0; i < count; i++) {
    seed(p, i, bounds, random);
    // Otherwise every particle created together respawns together, and the
    // whole layer visibly blinks every few seconds.
    p.age[i] = random() * p.maxAge[i];
  }
  return p;
}

/**
 * Advances every particle one frame along the wind, in place. A particle is
 * re-seeded when it ages out, reaches missing data, or leaves `bounds`.
 *
 * Motion is a constant screen speed per knot at every zoom: true wind speed
 * would be invisible (100 kt is about 0.0005 degrees a second).
 */
export function stepParticles(
  p: Particles,
  field: WindField,
  bounds: GeoBounds,
  { dtS, pxPerKtS, degPerPx }: StepOptions,
  random: () => number = Math.random,
): void {
  const dt = Math.min(Math.max(dtS, 0), MAX_STEP_S);
  const scale = pxPerKtS * dt * degPerPx;
  const uv = [0, 0];

  for (let i = 0; i < p.count; i++) {
    p.reborn[i] = 0;
    p.age[i] += dt;
    if (p.age[i] >= p.maxAge[i]) {
      seed(p, i, bounds, random);
      continue;
    }

    const lat = p.lat[i];
    const lon = p.lon[i];
    if (!sampleWind(field, lat, lon, uv)) {
      seed(p, i, bounds, random);
      continue;
    }

    const nextLon = lon + uv[0] * scale;
    const nextLat = lat + uv[1] * scale * Math.cos(lat * DEG);
    if (nextLat < bounds.south || nextLat > bounds.north || nextLon < bounds.west || nextLon > bounds.east) {
      seed(p, i, bounds, random);
      continue;
    }

    p.lat[i] = nextLat;
    p.lon[i] = nextLon;
    p.speedKt[i] = Math.hypot(uv[0], uv[1]);
  }
}

import { haversineDistanceNm } from "../geo";

/**
 * Web Mercator (slippy map) tile geometry for the tile-cache footprint.
 *
 * The footprint is a circle around the receiver; a tile belongs to it when any
 * part of the tile is inside the circle, so the map never shows a hole at the
 * edge of the cached area.
 */

/** Web Mercator's latitude limit: tiles stop at ±85.0511°. */
export const MAX_MERCATOR_LAT = 85.05112878;

/** Typical tile size across the providers we use; for estimates only. */
export const AVG_TILE_BYTES = 15_000;

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export interface TileBounds {
  west: number;
  east: number;
  north: number;
  south: number;
}

function tileYToLat(y: number, n: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
}

/** Geographic bounds of tile `z/x/y`. Row 0 is the northern edge. */
export function tileBounds(z: number, x: number, y: number): TileBounds {
  const n = 2 ** z;
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: tileYToLat(y, n),
    south: tileYToLat(y + 1, n),
  };
}

/** The tile holding a point at zoom `z` (unwrapped: x may fall outside [0, 2^z)). */
export function lonLatToTile(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const rad = (clamped * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y: Math.min(n - 1, Math.max(0, y)) };
}

/** Signed longitude difference folded into (-180, 180]. */
function lonDelta(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * True when tile `z/x/y` comes within `radiusNm` of the point.
 *
 * Distance is measured to the nearest point of the tile's lat/lon box (latitude
 * clamped, longitude clamped across the antimeridian). That is exact along a
 * meridian and very slightly generous across one, which errs toward caching a
 * marginal tile rather than leaving a gap.
 */
export function tileIntersectsCircle(
  z: number,
  x: number,
  y: number,
  lat: number,
  lon: number,
  radiusNm: number,
): boolean {
  const b = tileBounds(z, x, y);
  const nearLat = Math.max(b.south, Math.min(b.north, lat));
  const toWest = lonDelta(lon, b.west);
  const width = b.east - b.west;
  let nearLon: number;
  if (toWest >= 0 && toWest <= width) {
    nearLon = lon;
  } else {
    const toEast = lonDelta(lon, b.east);
    nearLon = Math.abs(toWest) < Math.abs(toEast) ? b.west : b.east;
  }
  return haversineDistanceNm(lat, lon, nearLat, nearLon) <= radiusNm;
}

/**
 * Every tile from zoom `minZoom` to `maxZoom` that intersects the circle.
 * A generator so a z12 enumeration (~75k tiles at 500 NM) never sits in memory.
 */
export function* tilesInRadius(
  lat: number,
  lon: number,
  radiusNm: number,
  maxZoom: number,
  minZoom = 0,
): Generator<TileCoord> {
  const dLat = radiusNm / 60;
  const north = Math.min(MAX_MERCATOR_LAT, lat + dLat);
  const south = Math.max(-MAX_MERCATOR_LAT, lat - dLat);
  // Longitude span widens with latitude; at the edge of the circle nearest the
  // pole it is widest. Near a pole the circle wraps the world.
  const poleward = Math.max(Math.abs(north), Math.abs(south));
  const cos = Math.cos((poleward * Math.PI) / 180);
  const dLon = cos > 1e-6 ? radiusNm / (60 * cos) : 360;
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 2 ** z;
    const yTop = lonLatToTile(north, lon, z).y;
    const yBottom = lonLatToTile(south, lon, z).y;
    let x0: number;
    let x1: number;
    if (dLon >= 180) {
      x0 = 0;
      x1 = n - 1;
    } else {
      x0 = lonLatToTile(lat, lon - dLon, z).x;
      x1 = lonLatToTile(lat, lon + dLon, z).x;
      if (x1 - x0 >= n) x1 = x0 + n - 1;
    }
    for (let ux = x0; ux <= x1; ux++) {
      const x = ((ux % n) + n) % n;
      for (let y = yTop; y <= yBottom; y++) {
        if (tileIntersectsCircle(z, x, y, lat, lon, radiusNm)) yield { z, x, y };
      }
    }
  }
}

/** How many tiles (and roughly how many bytes) a prefetch to `maxZoom` would fetch. */
export function estimateTiles(
  lat: number,
  lon: number,
  radiusNm: number,
  maxZoom: number,
): { count: number; bytes: number } {
  let count = 0;
  for (const tile of tilesInRadius(lat, lon, radiusNm, maxZoom)) {
    void tile;
    count++;
  }
  return { count, bytes: count * AVG_TILE_BYTES };
}

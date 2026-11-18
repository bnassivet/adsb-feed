/** Geodesy for the Cesium variant: WGS84 → ECEF, and a camera height matching a slippy-map zoom. */
import type { Flat } from "./flatten";

export const FEET_TO_M = 0.3048;

const A = 6_378_137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = Math.PI / 180;

/** Geodetic (degrees, metres above the ellipsoid) → Earth-centred Cartesian, as Cartesian3.fromDegrees. */
export function toEcef(lng: number, lat: number, h: number): [number, number, number] {
  const φ = lat * DEG;
  const λ = lng * DEG;
  const sinφ = Math.sin(φ);
  const cosφ = Math.cos(φ);
  const n = A / Math.sqrt(1 - E2 * sinφ * sinφ);
  return [(n + h) * cosφ * Math.cos(λ), (n + h) * cosφ * Math.sin(λ), (n * (1 - E2) + h) * sinφ];
}

/** Interleaved x, y, z for every position. Unknown altitude is drawn on the ellipsoid. */
export function flatToEcef(f: Flat): Float64Array {
  const out = new Float64Array(f.count * 3);
  for (let i = 0; i < f.count; i++) {
    const alt = f.alt[i];
    const [x, y, z] = toEcef(f.lng[i], f.lat[i], Number.isNaN(alt) ? 0 : alt * FEET_TO_M);
    out[3 * i] = x;
    out[3 * i + 1] = y;
    out[3 * i + 2] = z;
  }
  return out;
}

/**
 * Height for a straight-down camera whose view is as tall (in metres) as a
 * 256-px-tile slippy map at `zoom`. Cesium's `fov` applies to the wider
 * viewport dimension, so for a landscape viewport the vertical fov is narrower.
 */
export function zoomToCameraHeight(zoom: number, lat: number, width: number, height: number, fov: number): number {
  const metresPerPx = (2 * Math.PI * A * Math.cos(lat * DEG)) / (256 * 2 ** zoom);
  const aspect = width / height;
  const fovy = aspect >= 1 ? 2 * Math.atan(Math.tan(fov / 2) / aspect) : fov;
  return (height * metresPerPx) / (2 * Math.tan(fovy / 2));
}

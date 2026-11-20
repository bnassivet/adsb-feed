/**
 * Geometry for the occlusion probe (`/bench/occlusion`, `npm run bench:checks`):
 * does a hill or a building hide an aircraft behind it once deck.gl is
 * interleaved with MapLibre?
 *
 * The probe does not trust its own scene: it computes, from the rendered
 * terrain and building heights, one aircraft position whose line of sight from
 * the camera is blocked and one at the same altitude whose line is clear. The
 * render then has to agree.
 *
 * Lines of sight are straight in longitude, latitude and altitude, with no
 * Earth curvature, because that is how MapLibre's flat (Mercator) view draws
 * them. Pure: tested without a map.
 */

export type LngLat = [number, number];
export interface Point3 {
  lng: number;
  lat: number;
  /** Metres above sea level, as deck.gl draws z. */
  alt: number;
}
export type ElevationAt = (p: LngLat) => number | null;

const R = 6_371_008.8;
const DEG = Math.PI / 180;

/** Great-circle point `distM` from `from` along `bearing` (degrees from north). */
export function destination([lng, lat]: LngLat, bearing: number, distM: number): LngLat {
  const δ = distM / R;
  const θ = bearing * DEG;
  const φ1 = lat * DEG;
  const λ1 = lng * DEG;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [λ2 / DEG, φ2 / DEG];
}

export function distanceM([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const a = Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(((lng2 - lng1) * DEG) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Initial bearing from `a` to `b`, degrees in [0, 360). */
export function bearingDeg([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const Δλ = (lng2 - lng1) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) / DEG) % 360 + 360) % 360;
}

/** Even-odd rule; the ring may be open or closed. */
export function pointInPolygon([x, y]: LngLat, ring: readonly LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Sight {
  clear: boolean;
  /** Smallest (ray altitude − surface) along the line; negative = blocked by that much. */
  marginM: number;
}

/**
 * Sample the straight line from `from` to `to` every `stepM` and compare it with
 * the surface. The first and last 2% are skipped: that is the ground under the
 * camera and under the aircraft, not something between them.
 */
export function lineOfSight(from: Point3, to: Point3, elevationAt: ElevationAt, stepM = 25): Sight {
  const d = distanceM([from.lng, from.lat], [to.lng, to.lat]);
  const n = Math.max(10, Math.ceil(d / stepM));
  let margin = Infinity;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (t < 0.02 || t > 0.98) continue;
    const p: LngLat = [from.lng + (to.lng - from.lng) * t, from.lat + (to.lat - from.lat) * t];
    const ground = elevationAt(p);
    if (ground === null) continue;
    margin = Math.min(margin, from.alt + (to.alt - from.alt) * t - ground);
  }
  return { clear: margin >= 0, marginM: margin };
}

export interface ProbeSearch {
  camera: Point3;
  /** What should hide the aircraft: a summit or a building. */
  anchor: LngLat;
  elevationAt: ElevationAt;
  /** Candidate distances beyond the anchor, along the camera's line of view. */
  distancesM: readonly number[];
  /** Candidate sideways offsets for the visible twin, tried on both sides. */
  lateralM: readonly number[];
  /** Height of the aircraft above the ground under it. */
  clearanceM: number;
  /** A probe only counts if its line of sight is blocked (or clear) by at least this much. */
  minMarginM: number;
  /** Sampling step along each line; buildings need a few metres, terrain 25. */
  stepM?: number;
}

export interface Probes {
  hidden: Point3;
  visible: Point3;
  hiddenMarginM: number;
  visibleMarginM: number;
}

/** First hidden position behind the anchor that has a visible twin at the same altitude; null if none. */
export function findProbes(s: ProbeSearch): Probes | null {
  const view = bearingDeg([s.camera.lng, s.camera.lat], s.anchor);
  for (const d of s.distancesM) {
    const [lng, lat] = destination(s.anchor, view, d);
    const ground = s.elevationAt([lng, lat]);
    if (ground === null) continue;
    const hidden: Point3 = { lng, lat, alt: ground + s.clearanceM };
    const h = lineOfSight(s.camera, hidden, s.elevationAt, s.stepM);
    if (h.marginM > -s.minMarginM) continue;
    for (const o of s.lateralM) {
      for (const side of [90, -90]) {
        const [vlng, vlat] = destination([lng, lat], view + side, o);
        const vg = s.elevationAt([vlng, vlat]);
        // Still airborne at the shared altitude.
        if (vg === null || vg > hidden.alt - s.clearanceM / 2) continue;
        const visible: Point3 = { lng: vlng, lat: vlat, alt: hidden.alt };
        const v = lineOfSight(s.camera, visible, s.elevationAt, s.stepM);
        if (v.marginM >= s.minMarginM) return { hidden, visible, hiddenMarginM: h.marginM, visibleMarginM: v.marginM };
      }
    }
  }
  return null;
}

/** Pixels (RGBA) whose largest channel difference exceeds `tol`. */
export function changedPixels(a: Uint8ClampedArray, b: Uint8ClampedArray, tol = 24): number {
  if (a.length !== b.length) throw new Error(`image sizes differ: ${a.length} vs ${b.length}`);
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d > tol) n++;
  }
  return n;
}

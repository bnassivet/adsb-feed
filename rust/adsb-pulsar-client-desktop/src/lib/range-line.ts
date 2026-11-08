/**
 * Range lines: receiver → selected aircraft. Pure geometry and text; the map
 * layer (`RangeLinesLayer` in MapInner) only draws what these return.
 */
import type { AircraftTrack } from "./types";
import {
  receiverDistanceNm,
  receiverAzimuthDeg,
  receiverElevationDeg,
  formatDistance,
  formatAngle,
  type ReceiverPoint,
} from "./aircraft-details";

export type LatLng = [number, number];

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

function toVector([lat, lng]: LatLng): [number, number, number] {
  const p = toRad(lat);
  const l = toRad(lng);
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}

/**
 * Points along the great circle from `from` to `to`, endpoints exact.
 *
 * A Leaflet polyline between two points is a straight segment in Web Mercator,
 * i.e. a rhumb line. Its direction at the receiver differs from the true
 * (great-circle) azimuth the details panel shows. Interpolating the great circle
 * makes the drawn line leave the receiver along the bearing in its own label.
 */
export function greatCirclePoints(from: LatLng, to: LatLng, segments = 32): LatLng[] {
  const a = toVector(from);
  const b = toVector(to);
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const delta = Math.acos(dot);
  if (delta === 0) return [from, to];

  const sinDelta = Math.sin(delta);
  const points: LatLng[] = [from];
  for (let i = 1; i < segments; i++) {
    const f = i / segments;
    let lat: number;
    let lng: number;
    if (sinDelta < 1e-6) {
      // (Near-)antipodal: the great circle is undefined. Never a real receiver
      // range, but must not produce NaN.
      lat = from[0] + (to[0] - from[0]) * f;
      lng = from[1] + (to[1] - from[1]) * f;
    } else {
      const ka = Math.sin((1 - f) * delta) / sinDelta;
      const kb = Math.sin(f * delta) / sinDelta;
      const x = ka * a[0] + kb * b[0];
      const y = ka * a[1] + kb * b[1];
      const z = ka * a[2] + kb * b[2];
      lat = toDeg(Math.atan2(z, Math.hypot(x, y)));
      lng = toDeg(Math.atan2(y, x));
    }
    // Keep longitudes continuous so a line crossing the antimeridian is not drawn
    // the long way round the world.
    const prev = points[points.length - 1][1];
    while (lng - prev > 180) lng -= 360;
    while (lng - prev < -180) lng += 360;
    points.push([lat, lng]);
  }
  let endLng = to[1];
  const prev = points[points.length - 1][1];
  if (endLng - prev > 180 || endLng - prev < -180) {
    while (endLng - prev > 180) endLng -= 360;
    while (endLng - prev < -180) endLng += 360;
    points.push([to[0], endLng]);
  } else {
    points.push(to);
  }
  return points;
}

/** The middle point of a line; the arc midpoint for `greatCirclePoints` (even segments). */
export function midpoint(points: readonly LatLng[]): LatLng {
  return points[Math.floor(points.length / 2)];
}

/**
 * `"111 km / 60.0 NM · 180.0° · el 5.0°"`, built from the details panel's own
 * helpers so the map chip and the panel can never disagree. Bearing is omitted
 * directly overhead and elevation without an altitude; null without a position.
 */
export function rangeLineLabel(
  track: Pick<AircraftTrack, "latitude" | "longitude" | "altitude">,
  receiver: ReceiverPoint,
): string | null {
  const nm = receiverDistanceNm(track, receiver);
  if (nm === null) return null;
  const parts = [formatDistance(nm)];
  const az = receiverAzimuthDeg(track, receiver);
  if (az !== null) parts.push(formatAngle(az, { wrap360: true }));
  const el = receiverElevationDeg(track, receiver);
  if (el !== null) parts.push(`el ${formatAngle(el)}`);
  return parts.join(" · ");
}

/**
 * The selected tracks a range line can be drawn to: on the map (`tracksByKey`
 * holds only visible tracks, so hidden ones drop out) and with a position.
 */
export function rangeLineTargets(
  selected: ReadonlySet<string>,
  tracksByKey: ReadonlyMap<string, AircraftTrack>,
): AircraftTrack[] {
  const out: AircraftTrack[] = [];
  for (const key of selected) {
    const t = tracksByKey.get(key);
    if (t && t.latitude !== null && t.longitude !== null) out.push(t);
  }
  return out;
}

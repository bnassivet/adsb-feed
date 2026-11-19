/**
 * From ADS-B pressure altitude to altitude above mean sea level, with the QNH
 * of the nearest METAR station.
 *
 * ADS-B barometric altitude is referenced to the standard 1013.25 hPa. Terrain,
 * buildings and airspace limits in feet are above MSL. Below the transition
 * altitude aircraft fly on QNH, so the comparison needs the correction; above
 * it they fly flight levels, which are themselves pressure altitudes.
 *
 * Temperature is ignored: this is what an altimeter set to QNH would read, not
 * true altitude (which a cold day lowers further).
 */
import { ageMinutes, isOld, type Metar } from "./metar";

/** North American transition altitude. Europe varies by country (often 5000–7000 ft). */
export const TRANSITION_ALTITUDE_FT = 18_000;
/** Beyond this, a station's QNH says little about the aircraft's pressure. */
export const MAX_QNH_DISTANCE_NM = 100;

const STD_HPA = 1013.25;
/** ISA constants of the pressure-altitude formula h = K·(1 − (p/p0)^N). */
const K_FT = 145_366.45;
const N = 0.190263;

/**
 * The altitude an altimeter set to `qnhHpa` reads, given pressure altitude.
 * Exact in ISA, from h_qnh = K·(1 − (p/QNH)^N) with p from the pressure altitude.
 */
export function qnhAltitudeFt(pressureAltitudeFt: number, qnhHpa: number): number {
  return K_FT * (1 - (STD_HPA / qnhHpa) ** N * (1 - pressureAltitudeFt / K_FT));
}

export interface QnhSource {
  qnhHpa: number;
  stationId: string;
  distanceNm: number;
}

function distanceNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(a));
}

/** The QNH of the nearest station with a current report, within `maxNm`. */
export function nearestQnh(metars: Metar[], lat: number, lng: number, nowMs: number, maxNm = MAX_QNH_DISTANCE_NM): QnhSource | null {
  let best: QnhSource | null = null;
  for (const m of metars) {
    if (m.qnhHpa == null || isOld(ageMinutes(m.obsTimeMs, nowMs))) continue;
    const d = distanceNm(lat, lng, m.lat, m.lng);
    if (d <= maxNm && (!best || d < best.distanceNm)) best = { qnhHpa: m.qnhHpa, stationId: m.id, distanceNm: d };
  }
  return best;
}

/** Altitude above MSL, rounded, or null when it does not apply (no data, or at/above the transition altitude). */
export function mslAltitude(pressureAltitudeFt: number | null, qnh: QnhSource | null): number | null {
  if (pressureAltitudeFt == null || !qnh || pressureAltitudeFt >= TRANSITION_ALTITUDE_FT) return null;
  return Math.round(qnhAltitudeFt(pressureAltitudeFt, qnh.qnhHpa));
}

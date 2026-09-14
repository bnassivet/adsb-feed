/**
 * The wind a tracked aircraft is flying through, from the held snapshot.
 */
import type { AircraftTrack } from "./types";
import {
  interpolateWind,
  windComponents,
  type WeatherSnapshot,
  type Wind,
  type WindComponents,
} from "./weather";

export type AircraftWind = Wind & WindComponents;

/**
 * Wind at the aircraft's position and pressure altitude, with its head/tail
 * and crosswind components along the aircraft's track.
 *
 * Null when it cannot be known: no snapshot; no position, altitude or track;
 * outside the grid or above the levels it covers; or on the ground, where a
 * "headwind" along a taxiway heading means nothing.
 */
export function aircraftWind(
  snapshot: WeatherSnapshot | null,
  track: AircraftTrack,
): AircraftWind | null {
  if (!snapshot || track.is_on_ground) return null;
  const { latitude, longitude, altitude, track: trackDeg } = track;
  if (latitude == null || longitude == null || altitude == null || trackDeg == null) {
    return null;
  }
  const wind = interpolateWind(snapshot, latitude, longitude, altitude);
  if (!wind) return null;
  return { ...wind, ...windComponents(wind, trackDeg) };
}

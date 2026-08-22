"use client";
import { useMemo } from "react";
import type {
  AgentTrajectory,
  DynamicWaypoint,
  FlightPhase,
} from "@/lib/simulation-data";
import { isVisible, type PlaybackMap } from "@/lib/trajectory-playback";
import type { AircraftTrack } from "@/lib/types";

/**
 * Renders agent-generated trajectories as `AircraftTrack`s at whatever point
 * their playback clocks currently sit.
 *
 * Deliberately a sibling of `useSimulatedTracks` rather than an extension:
 * that hook walks hardcoded routes at a fixed progress-per-tick and loops
 * forever, its `ground_speed` a display field with no bearing on how fast the
 * icon moves. Here position is sampled from each waypoint's `t_offset_s`, so
 * the aircraft moves at the speed the agent actually computed.
 *
 * The hook holds **no state**: given the same trajectories and playback map it
 * returns the same tracks. That is what makes scrubbing work — dragging the
 * timeline backwards redraws the trail correctly instead of leaving a stale
 * one behind. Clocks live in `useTrajectoryPlayback`.
 *
 * Coordinates are absolute: the agent already built the route around the
 * receiver, so applying the SIMULATION_ORIGIN delta again would double-shift it.
 */

const MAX_POSITIONS = 100;

export interface TrajectorySample {
  lat: number;
  lng: number;
  altFt: number;
  speedKts: number;
  headingDeg: number;
  phase: FlightPhase;
}

/** Interpolate between two headings the short way round the compass. */
export function interpolateHeading(a: number, b: number, t: number): number {
  // Reduce the difference to [-180, 180] so 350 -> 10 is a 20 degree turn
  // through north rather than 340 degrees the other way.
  const delta = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + delta * t) % 360) + 360) % 360;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function toSample(w: DynamicWaypoint): TrajectorySample {
  return {
    lat: w.lat,
    lng: w.lng,
    altFt: w.alt_ft,
    speedKts: w.speed_kts,
    headingDeg: w.heading_deg,
    phase: w.phase,
  };
}

/** Position along a trajectory at `elapsedS` seconds, clamped to its extent. */
export function sampleTrajectory(
  waypoints: DynamicWaypoint[],
  elapsedS: number,
): TrajectorySample | null {
  if (waypoints.length === 0) return null;

  const last = waypoints[waypoints.length - 1];
  if (elapsedS <= waypoints[0].t_offset_s) return toSample(waypoints[0]);
  if (elapsedS >= last.t_offset_s) return toSample(last);

  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    if (elapsedS < a.t_offset_s || elapsedS > b.t_offset_s) continue;

    const span = b.t_offset_s - a.t_offset_s;
    // Duplicate timestamps would otherwise produce NaN.
    const t = span > 0 ? (elapsedS - a.t_offset_s) / span : 0;
    return {
      lat: lerp(a.lat, b.lat, t),
      lng: lerp(a.lng, b.lng, t),
      altFt: lerp(a.alt_ft, b.alt_ft, t),
      speedKts: lerp(a.speed_kts, b.speed_kts, t),
      headingDeg: interpolateHeading(a.heading_deg, b.heading_deg, t),
      // The phase of the segment being flown, not the one being flown toward.
      phase: a.phase,
    };
  }

  return toSample(last);
}

/**
 * The trail behind an aircraft at `elapsedS` — every waypoint already flown,
 * plus the interpolated current position.
 *
 * Derived from the route rather than accumulated over time, so seeking
 * backwards shortens the trail instead of leaving the earlier path drawn.
 */
export function trailUpTo(
  waypoints: DynamicWaypoint[],
  elapsedS: number,
  max: number = MAX_POSITIONS,
): [number, number, number | null][] {
  if (waypoints.length === 0) return [];

  const flown = waypoints.filter((w) => w.t_offset_s <= elapsedS);
  const trail: [number, number, number | null][] = flown.map((w) => [
    w.lat,
    w.lng,
    w.alt_ft,
  ]);

  const current = sampleTrajectory(waypoints, elapsedS);
  const lastFlown = flown[flown.length - 1];
  // Skip the duplicate when the clock sits exactly on a waypoint.
  if (current && (!lastFlown || lastFlown.t_offset_s !== elapsedS)) {
    trail.push([current.lat, current.lng, current.altFt]);
  }

  return trail.slice(-max);
}

/**
 * @param trajectories Agent-generated trajectories.
 * @param playback Per-trajectory transport state from `useTrajectoryPlayback`.
 * @returns Tracks for every non-stopped trajectory, ready to merge into the map.
 */
export function useAgentSimulatedTracks(
  trajectories: AgentTrajectory[],
  playback: PlaybackMap,
): AircraftTrack[] {
  return useMemo(() => {
    const now = Date.now();
    const tracks: AircraftTrack[] = [];

    for (const traj of trajectories) {
      const entry = playback[traj.hex_ident];
      if (!isVisible(entry)) continue;

      const sample = sampleTrajectory(traj.waypoints, entry.elapsedS);
      if (!sample) continue;

      tracks.push({
        hex_ident: traj.hex_ident,
        callsign: traj.callsign,
        altitude: Math.round(sample.altFt),
        ground_speed: Math.round(sample.speedKts),
        track: Math.round(sample.headingDeg),
        latitude: sample.lat,
        longitude: sample.lng,
        vertical_rate: null,
        squawk: null,
        is_on_ground: sample.altFt <= 0,
        timestamp: new Date(now).toISOString(),
        positions: trailUpTo(traj.waypoints, entry.elapsedS),
        // Wall-clock instant this aircraft's route began, derived from its clock.
        first_seen: now - entry.elapsedS * 1000,
        last_seen: now,
        message_count: 0,
      });
    }

    return tracks;
  }, [trajectories, playback]);
}

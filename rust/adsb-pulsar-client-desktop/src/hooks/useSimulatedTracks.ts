"use client";
import { useEffect, useRef, useState } from "react";
import { SIMULATED_FLIGHTS } from "@/lib/simulation-data";
import type { SimulatedFlight } from "@/lib/simulation-data";
import type { AircraftTrack } from "@/lib/types";

const TICK_MS = 2000;
const PROGRESS_PER_TICK = 0.04; // ~25 ticks per segment → ~50s per segment
const MAX_POSITIONS = 100;

interface FlightState {
  segmentIndex: number;
  segmentProgress: number;
  positions: [number, number, number | null][];
}

/** Compute heading in degrees (0-360) from point A to point B. */
export function computeHeading(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dlat = lat2 - lat1;
  const dlng = lng2 - lng1;
  const midLat = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const angle =
    Math.atan2(dlng * Math.cos(midLat), dlat) * (180 / Math.PI);
  return (angle + 360) % 360;
}

/** Linearly interpolate between two waypoints. */
export function interpolate(
  a: [number, number],
  b: [number, number],
  t: number,
): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function buildTrack(
  flight: SimulatedFlight,
  state: FlightState,
): AircraftTrack {
  const wp = flight.waypoints;
  const a = wp[state.segmentIndex];
  const b = wp[state.segmentIndex + 1] ?? wp[0]; // safety fallback
  const [lat, lng] = interpolate(a, b, state.segmentProgress);
  const heading = computeHeading(a[0], a[1], b[0], b[1]);

  return {
    hex_ident: flight.hex_ident,
    callsign: flight.callsign,
    altitude: flight.altitude,
    ground_speed: flight.ground_speed,
    track: Math.round(heading),
    latitude: lat,
    longitude: lng,
    vertical_rate: flight.vertical_rate,
    squawk: flight.squawk,
    is_on_ground: flight.is_on_ground,
    timestamp: new Date().toISOString(),
    positions: state.positions,
    last_seen: Date.now(),
    message_count: 0,
  };
}

/**
 * Self-animating hook that produces simulated AircraftTrack objects
 * for demo/trade-show use. Tracks interpolate along predefined waypoints
 * and loop continuously.
 *
 * @param enabled Whether the simulation is active
 * @returns Array of simulated AircraftTrack objects (empty when disabled)
 */
export function useSimulatedTracks(enabled: boolean): AircraftTrack[] {
  const statesRef = useRef<FlightState[] | null>(null);
  const [tracks, setTracks] = useState<AircraftTrack[]>([]);

  useEffect(() => {
    if (!enabled) {
      statesRef.current = null;
      setTracks([]);
      return;
    }

    // Initialize per-flight state — stagger starting progress so aircraft
    // aren't all bunched at waypoint 0 on first enable
    statesRef.current = SIMULATED_FLIGHTS.map((_, i) => ({
      segmentIndex: 0,
      segmentProgress: (i * 0.15) % 1, // slight offset per flight
      positions: [],
    }));

    const interval = setInterval(() => {
      const states = statesRef.current;
      if (!states) return;

      const newTracks: AircraftTrack[] = [];

      for (let i = 0; i < SIMULATED_FLIGHTS.length; i++) {
        const flight = SIMULATED_FLIGHTS[i];
        const state = states[i];
        const maxSegment = flight.waypoints.length - 1;

        // Advance progress
        state.segmentProgress += PROGRESS_PER_TICK;

        // Move to next segment when progress >= 1
        if (state.segmentProgress >= 1) {
          state.segmentProgress -= 1;
          state.segmentIndex += 1;

          // Loop: reset to beginning when route completes
          if (state.segmentIndex >= maxSegment) {
            state.segmentIndex = 0;
            state.segmentProgress = 0;
            state.positions = []; // clear trail to avoid teleport line
          }
        }

        // Interpolate current position
        const wp = flight.waypoints;
        const a = wp[state.segmentIndex];
        const b = wp[state.segmentIndex + 1] ?? wp[0];
        const [lat, lng] = interpolate(a, b, state.segmentProgress);

        // Accumulate position trail
        state.positions = [
          ...state.positions.slice(-(MAX_POSITIONS - 1)),
          [lat, lng, flight.altitude],
        ];

        newTracks.push(buildTrack(flight, state));
      }

      setTracks(newTracks);
    }, TICK_MS);

    return () => clearInterval(interval);
  }, [enabled]);

  return tracks;
}

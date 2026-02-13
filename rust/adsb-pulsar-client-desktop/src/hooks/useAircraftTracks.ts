"use client";
import { useMemo } from "react";
import { useAircraftTrackingContext } from "@/contexts/AircraftTrackingContext";
import type { AircraftTrack, Filters } from "@/lib/types";

function matchesFilters(t: AircraftTrack, filters: Filters): boolean {
  if (
    filters.callsign &&
    !(t.callsign ?? "")
      .toLowerCase()
      .includes(filters.callsign.toLowerCase()) &&
    !t.hex_ident.toLowerCase().includes(filters.callsign.toLowerCase())
  ) {
    return false;
  }
  if (t.altitude !== null) {
    if (t.altitude < filters.altitudeMin || t.altitude > filters.altitudeMax) {
      return false;
    }
  }
  if (t.ground_speed !== null) {
    if (t.ground_speed < filters.speedMin || t.ground_speed > filters.speedMax) {
      return false;
    }
  }
  return true;
}

/**
 * Hook to access filtered aircraft tracks and history from the global tracking context.
 * The global context keeps running across page navigation, so history accumulates
 * even when viewing the Settings page.
 *
 * @param filters User-specified filter criteria
 * @returns Filtered active tracks and history tracks
 */
export function useAircraftTracks(filters: Filters) {
  const { tracks: tracksMap, history: historyMap } = useAircraftTrackingContext();

  const tracks = useMemo(
    () => Array.from(tracksMap.values()).filter((t) => matchesFilters(t, filters)),
    [tracksMap, filters],
  );

  const history = useMemo(
    () => Array.from(historyMap.values()).filter((t) => matchesFilters(t, filters)),
    [historyMap, filters],
  );

  return { tracks, history };
}

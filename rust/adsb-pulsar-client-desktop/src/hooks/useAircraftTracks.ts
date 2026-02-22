"use client";
import { useMemo } from "react";
import { useAircraftTrackingContext } from "@/contexts/AircraftTrackingContext";
import type { AircraftTrack, Filters } from "@/lib/types";

export function matchesFilters(t: AircraftTrack, filters: Filters): boolean {
  if (filters.callsign) {
    const tokens = filters.callsign
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (tokens.length > 0) {
      const id = t.hex_ident.toLowerCase();
      const cs = (t.callsign ?? "").toLowerCase();
      if (!tokens.some((tok) => cs.includes(tok) || id.includes(tok))) {
        return false;
      }
    }
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
  const { tracks: tracksMap, history: historyMap, imported: importedMap, version, importTracks, clearImported } = useAircraftTrackingContext();

  const tracks = useMemo(
    () => Array.from(tracksMap.values()).filter((t) => matchesFilters(t, filters)),
    // version changes on every batch, ensuring useMemo recomputes even though tracksMap is the same ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, filters],
  );

  const history = useMemo(
    () => Array.from(historyMap.values()).filter((t) => matchesFilters(t, filters)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, filters],
  );

  const imported = useMemo(
    () => {
      const all = Array.from(importedMap.values());
      return filters.includeImportedInFilter
        ? all.filter((t) => matchesFilters(t, filters))
        : all;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, filters],
  );

  return { tracks, history, imported, importTracks, clearImported };
}

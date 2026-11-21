"use client";
import { useMemo } from "react";
import { useAircraftTrackingContext } from "@/contexts/AircraftTrackingContext";
import type { AircraftTrack, Filters } from "@/lib/types";
import { DEFAULT_FILTERS } from "@/lib/types";
import { compileCallsignQuery } from "@/lib/callsign-match";

export function matchesFilters(t: AircraftTrack, filters: Filters): boolean {
  if (filters.savedFilterId) {
    // A combined saved filter replaces the query (resolved by `resolveFilters`).
    if (filters.combinedMatcher && !filters.combinedMatcher(t.callsign, t.hex_ident)) return false;
  } else if (filters.callsign) {
    const { matcher } = compileCallsignQuery(filters.callsign, filters.callsignRegex ?? false);
    if (matcher && !matcher(t.callsign, t.hex_ident)) return false;
  }
  if (t.altitude !== null) {
    if (t.altitude < filters.altitudeMin || t.altitude > filters.altitudeMax) {
      return false;
    }
  }
  if (t.ground_speed !== null) {
    if (t.ground_speed < filters.speedMin) return false;
    // speedMax at the slider ceiling (DEFAULT_FILTERS.speedMax) means "no upper limit"
    if (filters.speedMax < DEFAULT_FILTERS.speedMax && t.ground_speed > filters.speedMax) {
      return false;
    }
  }
  return true;
}

/** How many of `tracks` pass `filters` (shown/total ratios). */
export function countMatching(tracks: readonly AircraftTrack[], filters: Filters): number {
  let n = 0;
  for (const t of tracks) if (matchesFilters(t, filters)) n++;
  return n;
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
  const {
    tracks: tracksMap,
    history: historyMap,
    imported: importedMap,
    dbHistory: dbHistoryMap,
    analysis: analysisMap,
    liveVersion,
    staticVersion,
    importTracks,
    clearImported,
    loadDbHistoryTracks,
    clearDbHistory,
    addAnalysisTracks,
    removeAnalysisTrack,
    clearAnalysis,
    trackHistoryHours,
  } = useAircraftTrackingContext();

  // Live tracks & history recompute on every feed batch (~500ms)
  const tracks = useMemo(
    () => Array.from(tracksMap.values()).filter((t) => matchesFilters(t, filters)),
    // liveVersion changes on every batch, ensuring useMemo recomputes even though tracksMap is the same ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveVersion, filters],
  );

  const history = useMemo(
    () => Array.from(historyMap.values()).filter((t) => matchesFilters(t, filters)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveVersion, filters],
  );

  // Static track categories only recompute on explicit user actions (load, clear, import)
  const imported = useMemo(
    () => {
      const all = Array.from(importedMap.values());
      return filters.includeImportedInFilter
        ? all.filter((t) => matchesFilters(t, filters))
        : all;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [staticVersion, filters],
  );

  // dbHistory is NOT filtered by live Filters — controlled by DBHistoryPanel
  const dbHistory = useMemo(
    () => Array.from(dbHistoryMap.values()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [staticVersion],
  );

  const analysis = useMemo(
    () => Array.from(analysisMap.values()).filter((t) => matchesFilters(t, filters)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [staticVersion, filters],
  );

  // Unfiltered, for shown/total ratios: each mode is counted with ITS OWN
  // filters by the page, whichever mode is active.
  const allLive = useMemo(
    () => Array.from(tracksMap.values()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveVersion],
  );
  const allAnalysis = useMemo(
    () => Array.from(analysisMap.values()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [staticVersion],
  );

  return {
    tracks, history, imported, dbHistory, analysis, allLive, allAnalysis,
    importTracks, clearImported, loadDbHistoryTracks, clearDbHistory,
    addAnalysisTracks, removeAnalysisTrack, clearAnalysis,
    trackHistoryHours,
  };
}

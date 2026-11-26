"use client";
import { useCallback, useState } from "react";
import { getOpenSkyTrack } from "@/lib/commands";
import { fetchFlightHistory, type HistoryEntry } from "@/lib/opensky-history";
import { trackKey, type AircraftTrack } from "@/lib/types";

export interface OpenSkyHistory {
  /** By track key, not hex: one aircraft can fly several recorded flights. */
  entries: Map<string, HistoryEntry>;
  fetch: (track: AircraftTrack) => void;
  /** Forgets a fetched flight: drawing it again means fetching it again. */
  discard: (key: string) => void;
}

/**
 * OpenSky's version of recorded flights (Analysis, History, DB History),
 * fetched on demand. Held only while the track is in `heldKeys`: a track that
 * leaves (removed, cleared, aged out of History) takes what was drawn for it,
 * and a fetch still running when it goes is discarded.
 */
export function useOpenSkyHistory(heldKeys: string[]): OpenSkyHistory {
  const [entries, setEntries] = useState<Map<string, HistoryEntry>>(() => new Map());

  // Render-phase adjustment: a track gone takes its history with it.
  const keep = new Set(heldKeys);
  if ([...entries.keys()].some((k) => !keep.has(k))) {
    setEntries(new Map([...entries].filter(([k]) => keep.has(k))));
  }

  const fetch = useCallback((track: AircraftTrack) => {
    const key = trackKey(track);
    setEntries((current) => new Map(current).set(key, { kind: "loading" }));
    fetchFlightHistory(track, (icao24, time) => getOpenSkyTrack(icao24, time)).then((entry) =>
      // Only into a slot still waiting: the track may have gone, or been discarded.
      setEntries((current) =>
        current.get(key)?.kind === "loading" ? new Map(current).set(key, entry) : current,
      ),
    );
  }, []);

  const discard = useCallback((key: string) => {
    setEntries((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, []);

  return { entries, fetch, discard };
}

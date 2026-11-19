"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getMetars } from "@/lib/commands";
import { prepareMetars, type Metar, type MetarSnapshot } from "@/lib/metar";

/** How often the layer asks again while on. Rust serves its memory cache within the same window. */
export const METAR_REFRESH_MS = 5 * 60_000;
/** Stations within this of the receiver; the same reach as the airspace layer. */
export const METAR_RADIUS_NM = 300;

const NONE: Metar[] = [];
const NO_RECEIVER = "No receiver location: METARs are fetched around the receiver (Settings).";

export interface UseMetars {
  /** Stations with their latest report; empty while the layer is off. */
  metars: Metar[];
  fetchedAtMs: number | null;
  /** The last refresh failed and these are the previous reports. */
  stale: boolean;
  loading: boolean;
  error: string | null;
  /** Ask again now, bypassing Rust's 5-minute cache (not its 60 s floor). */
  reload: () => void;
}

/**
 * Latest METARs around the receiver: loaded when the layer is switched on,
 * then refreshed every few minutes while it stays on.
 */
export function useMetars(enabled: boolean, center: { lat: number; lng: number } | null): UseMetars {
  const [snapshot, setSnapshot] = useState<MetarSnapshot | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  // When and where the last request went. Set synchronously, so StrictMode's
  // second effect run sees a fresh request and does not send another.
  const last = useRef<{ at: number; key: string }>({ at: -Infinity, key: "" });
  const lat = center?.lat;
  const lng = center?.lng;

  const load = useCallback(
    (force: boolean) => {
      if (lat == null || lng == null) return;
      last.current = { at: Date.now(), key: `${lat},${lng}` };
      getMetars(lat, lng, METAR_RADIUS_NM, force)
        .then((s) => {
          setSnapshot(s);
          setCommandError(null);
        })
        .catch((e: unknown) => setCommandError(e instanceof Error ? e.message : String(e)));
    },
    [lat, lng],
  );

  useEffect(() => {
    if (!enabled || lat == null || lng == null) return;
    const due = Date.now() - last.current.at >= METAR_REFRESH_MS || last.current.key !== `${lat},${lng}`;
    if (due) load(false);
    const id = setInterval(() => load(false), METAR_REFRESH_MS);
    return () => clearInterval(id);
  }, [enabled, lat, lng, load]);

  const reload = useCallback(() => load(true), [load]);
  const all = useMemo(() => (snapshot ? prepareMetars(snapshot.items) : NONE), [snapshot]);
  const noCenter = center == null;

  return {
    metars: enabled ? all : NONE,
    fetchedAtMs: snapshot?.fetchedAtMs ?? null,
    stale: snapshot?.origin === "stale-cache",
    loading: enabled && !noCenter && snapshot === null && commandError === null,
    error: enabled && noCenter ? NO_RECEIVER : (commandError ?? snapshot?.error ?? null),
    reload,
  };
}

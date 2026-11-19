"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getRadar } from "@/lib/commands";
import type { RadarSnapshot } from "@/lib/radar";

/** Rust checks for a new 5-minute image at most every 2.5 minutes: poll at the same pace. */
export const RADAR_REFRESH_MS = 150_000;
/** Same reach as the airspace and METAR layers. */
export const RADAR_RADIUS_NM = 300;

const NO_RECEIVER = "No receiver location: the radar image is cut around the receiver (Settings).";

export interface UseRadar {
  /** The latest image; null while the layer is off or before the first answer. */
  snapshot: RadarSnapshot | null;
  /** The last check failed; the image is the previous one. */
  stale: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Météo-France rain radar around the receiver: loaded when switched on, polled while on. */
export function useRadar(enabled: boolean, center: { lat: number; lng: number } | null): UseRadar {
  const [snapshot, setSnapshot] = useState<RadarSnapshot | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  // Set synchronously, so StrictMode's second effect run does not send a second request.
  const last = useRef<{ at: number; key: string }>({ at: -Infinity, key: "" });
  const lat = center?.lat;
  const lng = center?.lng;

  const load = useCallback(
    (force: boolean) => {
      if (lat == null || lng == null) return;
      last.current = { at: Date.now(), key: `${lat},${lng}` };
      getRadar(lat, lng, RADAR_RADIUS_NM, force)
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
    if (Date.now() - last.current.at >= RADAR_REFRESH_MS || last.current.key !== `${lat},${lng}`) load(false);
    const id = setInterval(() => load(false), RADAR_REFRESH_MS);
    return () => clearInterval(id);
  }, [enabled, lat, lng, load]);

  const reload = useCallback(() => load(true), [load]);
  const noCenter = center == null;
  return {
    snapshot: enabled ? snapshot : null,
    stale: snapshot?.origin === "stale-cache",
    loading: enabled && !noCenter && snapshot === null && commandError === null,
    error: enabled && noCenter ? NO_RECEIVER : (commandError ?? snapshot?.error ?? null),
    reload,
  };
}

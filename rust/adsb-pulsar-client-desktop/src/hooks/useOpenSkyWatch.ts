"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { clearOpenSkyWatch, setOpenSkyWatch } from "@/lib/commands";
import {
  computeWatch,
  hexKey,
  WATCH_RENEW_MS,
  watchSignature,
  type ExternalTrack,
  type OpenSkyArea,
  type OpenSkyMode,
  type WatchAccepted,
} from "@/lib/opensky";
import type { AircraftTrack } from "@/lib/types";

/** How often the gap rule is re-evaluated: a track goes stale without any event. */
export const WATCH_TICK_MS = 5_000;

export interface OpenSkyWatchInputs {
  /** The layer switch. Off sends nothing and drops the lease. */
  active: boolean;
  /** The aircraft followed (useOpenSkyFollow), not the selection. */
  followed: Iterable<string>;
  live: AircraftTrack[];
  external: Map<string, ExternalTrack>;
  receiver: { lat: number; lng: number } | null;
  mode: OpenSkyMode;
  areas: OpenSkyArea[];
  /** The service's MQTT availability: a service coming back online has lost
   *  every lease (it keeps none on disk), so the list is sent again at once. */
  online: boolean;
}

export interface OpenSkyWatchState {
  /** The aircraft currently asked for, lowercase icao24. */
  watched: string[];
  accepted: WatchAccepted | null;
  error: string | null;
  /** The clock the gap rule ran on, ticking every {@link WATCH_TICK_MS}. */
  now: number;
}

/**
 * Keeps the OpenSky service's lease on this desktop's watch list: sent on
 * every change of content, renewed every {@link WATCH_RENEW_MS}, re-sent when
 * the service comes back online, and dropped when the layer is switched off.
 */
export function useOpenSkyWatch(inputs: OpenSkyWatchInputs): OpenSkyWatchState {
  const { active, live, external, receiver, mode, areas, online } = inputs;
  const [now, setNow] = useState(() => Date.now());
  const [renewal, setRenewal] = useState(0);
  const [accepted, setAccepted] = useState<WatchAccepted | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const tick = setInterval(() => setNow(Date.now()), WATCH_TICK_MS);
    const renew = setInterval(() => setRenewal((n) => n + 1), WATCH_RENEW_MS);
    return () => {
      clearInterval(tick);
      clearInterval(renew);
    };
  }, [active]);

  const followedSig = [...inputs.followed].join(",");
  const liveMap = useMemo(
    () => new Map(live.map((t) => [hexKey(t.hex_ident), t])),
    [live],
  );
  const watched = useMemo(
    () =>
      active
        ? computeWatch({ followed: followedSig ? followedSig.split(",") : [], live: liveMap, external, receiver, mode, now })
        : [],
    [active, followedSig, liveMap, external, receiver, mode, now],
  );
  const signature = watchSignature(watched, areas);
  const empty = watched.length === 0 && areas.length === 0;

  // The last request this hook made, so an empty list after a non-empty one
  // is sent as a release, and nothing is sent while there was never anything.
  const holdsLease = useRef(false);
  // The latest values, read when the effect fires on its signature.
  const latest = useRef({ watched, areas });
  useEffect(() => {
    latest.current = { watched, areas };
  });

  useEffect(() => {
    if (!active || empty) {
      if (holdsLease.current) {
        holdsLease.current = false;
        clearOpenSkyWatch().catch(() => {});
      }
      return;
    }
    if (!online) return;
    holdsLease.current = true;
    const { watched: w, areas: a } = latest.current;
    setOpenSkyWatch(w, a)
      .then((ok) => {
        setAccepted(ok);
        setError(null);
      })
      .catch((e: unknown) => setError(typeof e === "string" ? e : String(e)));
  }, [active, empty, online, signature, renewal]);

  return { watched, accepted: active ? accepted : null, error: active ? error : null, now };
}

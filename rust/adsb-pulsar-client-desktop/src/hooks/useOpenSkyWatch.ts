"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { clearOpenSkyWatch, setOpenSkyWatch } from "@/lib/commands";
import {
  EMPTY_BACKOFF,
  heldBack,
  pruneBackoff,
  recordPoll,
  type NoDataBackoff,
} from "@/lib/opensky-backoff";
import {
  computeWatch,
  hexKey,
  lastLocalPositionMs,
  WATCH_RENEW_MS,
  watchSignature,
  type ExternalTrack,
  type OpenSkyArea,
  type OpenSkyMode,
  selectionHex,
  type WatchAccepted,
} from "@/lib/opensky";
import type { AircraftTrack } from "@/lib/types";
import type { OpenSkyPoll } from "./useOpenSky";

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
  /** The last poll received (useOpenSky), which feeds the no-data backoff. */
  lastPoll?: OpenSkyPoll | null;
}

export interface OpenSkyWatchState {
  /** The aircraft currently asked for, lowercase icao24. */
  watched: string[];
  accepted: WatchAccepted | null;
  error: string | null;
  /** The clock the gap rule ran on, ticking every {@link WATCH_TICK_MS}. */
  now: number;
  /** Followed aircraft OpenSky had no data on, by uppercase hex: asked for
   *  again with growing delays, then no more (opensky-backoff.ts). */
  noData: NoDataBackoff;
}

const EMPTY_ASKED: ReadonlyMap<string, number> = new Map();

/** Which aircraft the service accepted, and since when: kept for those still in `list`. */
function acceptedSince(
  prev: ReadonlyMap<string, number>,
  list: string[],
  at: number,
): ReadonlyMap<string, number> {
  const next = new Map<string, number>();
  for (const icao of list) {
    const hex = hexKey(icao);
    next.set(hex, prev.get(hex) ?? at);
  }
  return next;
}

/**
 * Keeps the OpenSky service's lease on this desktop's watch list: sent on
 * every change of content, renewed every {@link WATCH_RENEW_MS}, re-sent when
 * the service comes back online, and dropped when the layer is switched off.
 */
export function useOpenSkyWatch(inputs: OpenSkyWatchInputs): OpenSkyWatchState {
  const { active, live, external, receiver, mode, areas, online, lastPoll = null } = inputs;
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

  // The aircraft the service accepted, each with when: set once a list is
  // acknowledged, so a poll made before then is not taken as its answer.
  const [asked, setAsked] = useState<ReadonlyMap<string, number>>(EMPTY_ASKED);
  const [noData, setNoData] = useState<NoDataBackoff>(EMPTY_BACKOFF);
  const [seenPoll, setSeenPoll] = useState<OpenSkyPoll | null>(null);

  const followedSig = [...inputs.followed].join(",");
  const liveMap = useMemo(
    () => new Map(live.map((t) => [hexKey(t.hex_ident), t])),
    [live],
  );

  // Render-phase adjustments, in order: forget what no longer applies, then
  // fold in a poll not seen yet. Each returns the same map when nothing changed.
  const pruned = pruneBackoff(noData, {
    followed: followedSig ? followedSig.split(",").map(selectionHex) : [],
    lastLocalMs: (hex) => lastLocalPositionMs(liveMap.get(hex)),
  });
  const folded =
    lastPoll !== null && lastPoll !== seenPoll
      ? recordPoll(pruned, { pollMs: lastPoll.fetchedMs, named: lastPoll.named, asked })
      : pruned;
  if (lastPoll !== seenPoll) setSeenPoll(lastPoll);
  if (folded !== noData) setNoData(folded);
  if (!active && noData.size > 0) setNoData(EMPTY_BACKOFF);

  // Wake up when the next probe is due: the gap tick alone would send it up to
  // WATCH_TICK_MS late.
  const nextProbeMs = useMemo(() => {
    let next = Infinity;
    for (const e of folded.values()) if (!e.stopped && e.nextProbeMs > now) next = Math.min(next, e.nextProbeMs);
    return next;
  }, [folded, now]);
  useEffect(() => {
    if (!active || nextProbeMs === Infinity) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextProbeMs - Date.now()));
    return () => clearTimeout(timer);
  }, [active, nextProbeMs]);

  const held = useMemo(() => heldBack(folded, now), [folded, now]);
  const watched = useMemo(
    () =>
      active
        ? computeWatch({
            followed: followedSig ? followedSig.split(",") : [],
            live: liveMap,
            external,
            receiver,
            mode,
            now,
            heldBack: held,
          })
        : [],
    [active, followedSig, liveMap, external, receiver, mode, now, held],
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
        clearOpenSkyWatch()
          .then(() => setAsked(EMPTY_ASKED))
          .catch(() => {});
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
        const at = Date.now();
        setAsked((prev) => acceptedSince(prev, w, at));
      })
      .catch((e: unknown) => setError(typeof e === "string" ? e : String(e)));
  }, [active, empty, online, signature, renewal]);

  return { watched, accepted: active ? accepted : null, error: active ? error : null, now, noData: folded };
}

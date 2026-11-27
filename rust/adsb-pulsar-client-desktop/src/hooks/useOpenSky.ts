"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTauriEvent } from "./useTauriEvent";
import {
  getOpenSkyService,
  getOpenSkyStates,
  getOpenSkyTrack,
  setOpenSkyEnabled,
} from "@/lib/commands";
import {
  EMPTY_OPENSKY_VIEW,
  mergeStates,
  pruneOpenSky,
  staleAfterMs,
  type BackfillEntry,
  type OpenSkyHeld,
  type ExternalTrack,
  type OpenSkyServiceView,
  type StatesMessage,
} from "@/lib/opensky";

/** How long an enable/disable waits for the service to report it. */
export const CONFIRM_TIMEOUT_MS = 10_000;
/** How often aircraft that polls stopped mentioning are dropped. */
export const PRUNE_EVERY_MS = 10_000;

export type BackfillState = BackfillEntry;

export interface OpenSkyPoll {
  fetchedMs: number;
  named: ReadonlySet<string>;
}

export interface OpenSkyState {
  /** What the service last reported over MQTT. */
  service: OpenSkyServiceView;
  /** The last poll received while the layer is on: when it was made, and the
   *  aircraft it named (uppercase hex). A poll naming nobody still counts: it
   *  is OpenSky's answer, and the no-data backoff reads it. */
  lastPoll: OpenSkyPoll | null;
  /** OpenSky aircraft held, by uppercase hex. Never part of the live store. */
  external: Map<string, ExternalTrack>;
  /** Track backfills asked for, by uppercase hex. */
  backfill: Map<string, BackfillState>;
  requestBackfill: (hex: string) => void;
  clearBackfill: (hex: string) => void;
  pendingEnabled: boolean | null;
  serviceError: string | null;
  setServiceEnabled: (enabled: boolean) => void;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The OpenSky layer's data: polls folded into tracks, the service's status,
 * and on-demand track backfills.
 *
 * `active` is the layer switch. Off, polls are ignored and the held tracks
 * dropped, so a hidden layer holds nothing stale for when it comes back.
 */
export function useOpenSky(active: boolean): OpenSkyState {
  const [service, setService] = useState<OpenSkyServiceView>(EMPTY_OPENSKY_VIEW);
  // One state for both, so one update can drop a track and its backfill together.
  const [held, setHeld] = useState<OpenSkyHeld>(() => ({ external: new Map(), backfill: new Map() }));
  const { external, backfill } = held;
  const [lastPoll, setLastPoll] = useState<OpenSkyPoll | null>(null);
  const [requested, setRequested] = useState<boolean | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);

  // Render-phase adjustment: switching the layer off drops what it held.
  if (!active && (external.size > 0 || backfill.size > 0)) {
    setHeld({ external: new Map(), backfill: new Map() });
  }
  if (!active && lastPoll !== null) setLastPoll(null);

  useEffect(() => {
    getOpenSkyService()
      .then((view) =>
        setService((current) => (current.status || current.availability ? current : view)),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!active) return;
    getOpenSkyStates()
      .then((last) => {
        if (last)
          setHeld((current) =>
            current.external.size > 0
              ? current
              : { ...current, external: mergeStates(current.external, last, Date.now()) },
          );
      })
      .catch(() => {});
  }, [active]);

  // useTauriEvent subscribes once, with the first render's handler: the switch
  // is read through a ref, or a poll would always see its first value.
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useTauriEvent<StatesMessage>("adsb:opensky", (message) => {
    if (!activeRef.current) return;
    const now = Date.now();
    setHeld((current) => ({ ...current, external: mergeStates(current.external, message, now) }));
    setLastPoll({
      fetchedMs: message.fetched_ms,
      named: new Set(message.states.map(({ state }) => state.icao24.trim().toUpperCase())),
    });
  });
  useTauriEvent<OpenSkyServiceView>("adsb:opensky-service", setService);

  const interval = service.status?.interval_seconds ?? null;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setHeld((current) => pruneOpenSky(current, now, staleAfterMs(interval)));
    }, PRUNE_EVERY_MS);
    return () => clearInterval(timer);
  }, [active, interval]);

  // Confirmed: the service reports what was asked for.
  if (requested !== null && service.status?.enabled === requested) {
    setRequested(null);
  }

  useEffect(() => {
    if (requested === null) return;
    const timer = setTimeout(() => {
      setRequested(null);
      setServiceError(
        "No confirmation from the OpenSky service: is it running and connected to the broker?",
      );
    }, CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [requested]);

  const setServiceEnabled = useCallback((enabled: boolean) => {
    setServiceError(null);
    setRequested(enabled);
    setOpenSkyEnabled(enabled).catch((error: unknown) => {
      setRequested(null);
      setServiceError(errorMessage(error));
    });
  }, []);

  const setBackfill = useCallback(
    (update: (current: Map<string, BackfillEntry>) => Map<string, BackfillEntry>) =>
      setHeld((current) => ({ ...current, backfill: update(current.backfill) })),
    [],
  );

  const requestBackfill = useCallback((hex: string) => {
    const key = hex.toUpperCase();
    setBackfill((current) => new Map(current).set(key, { kind: "loading" } as BackfillEntry));
    getOpenSkyTrack(key.toLowerCase())
      .then(({ track }) =>
        setBackfill((current) =>
          new Map(current).set(key, track ? { kind: "done", track } : { kind: "none" }),
        ),
      )
      .catch((error: unknown) =>
        setBackfill((current) =>
          new Map(current).set(key, { kind: "error", message: errorMessage(error) }),
        ),
      );
  }, [setBackfill]);

  const clearBackfill = useCallback((hex: string) => {
    setBackfill((current) => {
      const next = new Map(current);
      next.delete(hex.toUpperCase());
      return next;
    });
  }, [setBackfill]);

  return {
    service,
    lastPoll,
    external,
    backfill,
    requestBackfill,
    clearBackfill,
    pendingEnabled: requested,
    serviceError,
    setServiceEnabled,
  };
}

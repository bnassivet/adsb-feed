"use client";
import { useCallback, useRef, useState } from "react";
import { getAircraftPhoto, getFlightInfo } from "@/lib/commands";
import type { FlightInfo } from "@/lib/types";

export interface UseFlightInfo {
  status: "idle" | "loading" | "loaded" | "error";
  info: FlightInfo | null;
  /** Photo thumbnail as a `data:` URL, once fetched. */
  photo: string | null;
  error: string | null;
  /** Ask the web for the selected aircraft. No-op for a simulated one. */
  request: () => void;
}

type Selection = { hex_ident: string; callsign: string | null } | null;

interface State {
  key: string | null;
  status: UseFlightInfo["status"];
  info: FlightInfo | null;
  photo: string | null;
  error: string | null;
}

const IDLE = { status: "idle", info: null, photo: null, error: null } as const;

/**
 * Flight info for the selected aircraft, fetched **only on request** (the
 * panel's "Show Flight Infos" button), never on selection. A new aircraft or
 * a new callsign resets to idle; an answer for a previous one is dropped.
 */
export function useFlightInfo(selection: Selection, isSimulated: boolean): UseFlightInfo {
  const hex = selection?.hex_ident ?? null;
  const callsign = selection?.callsign ?? null;
  const key = hex ? `${hex}|${callsign ?? ""}` : null;
  const [state, setState] = useState<State>({ key: null, ...IDLE });
  // The key whose answer is awaited; read in promise callbacks, never in render.
  const pending = useRef<string | null>(null);

  const request = useCallback(() => {
    if (!hex || !key || isSimulated) return;
    pending.current = key;
    setState({ key, ...IDLE, status: "loading" });
    getFlightInfo(hex, callsign)
      .then((info) => {
        if (pending.current !== key) return;
        setState({ key, status: "loaded", info, photo: null, error: null });
        if (!info.aircraft?.photo_thumb_url) return;
        return getAircraftPhoto(hex).then((photo) => {
          if (pending.current === key) setState((s) => (s.key === key ? { ...s, photo } : s));
        });
      })
      .catch((e: unknown) => {
        if (pending.current !== key) return;
        // A photo failure leaves the loaded info in place.
        setState((s) =>
          s.key === key && s.status === "loaded"
            ? s
            : { key, ...IDLE, status: "error", error: e instanceof Error ? e.message : String(e) },
        );
      });
  }, [hex, callsign, key, isSimulated]);

  // Another aircraft (or callsign) than the one answered: back to idle.
  const current = state.key === key ? state : { key, ...IDLE };
  return { status: current.status, info: current.info, photo: current.photo, error: current.error, request };
}

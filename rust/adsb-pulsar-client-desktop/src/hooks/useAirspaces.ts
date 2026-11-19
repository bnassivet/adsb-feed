"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAirspaces } from "@/lib/commands";
import { airspaceStatus, prepareAirspaces, type Airspace, type AirspaceStatus, type CountryAirspaces } from "@/lib/airspace";

export interface UseAirspaces {
  /** Drawable airspaces near `center`; empty while the layer is off. */
  airspaces: Airspace[];
  status: AirspaceStatus;
  loading: boolean;
  /** The command itself failed (per-country problems are in `status.errors`). */
  error: string | null;
  /** Ask Rust again, e.g. after setting a key: a new download only if the cycle's file is missing. */
  reload: () => void;
}

const EMPTY_STATUS: AirspaceStatus = { cycles: [], expired: false, errors: [] };
/** Stable while off, so map effects keyed on the list do not re-run every render. */
const NONE: Airspace[] = [];

/**
 * OpenAIP airspaces, loaded the first time the layer is switched on and kept
 * for the session. Rust caches per AIRAC cycle, so a load after the first
 * launch of a cycle is a file read.
 */
export function useAirspaces(enabled: boolean, center: { lat: number; lng: number } | null): UseAirspaces {
  const [countries, setCountries] = useState<CountryAirspaces[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A ref survives StrictMode's double effect, so the first switch-on loads once.
  const requested = useRef(false);

  const load = useCallback(() => {
    requested.current = true;
    getAirspaces()
      .then((c) => {
        setCountries(c);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (enabled && !requested.current) load();
  }, [enabled, load]);

  const reload = useCallback(() => {
    setCountries(null);
    setError(null);
    load();
  }, [load]);

  const lat = center?.lat;
  const lng = center?.lng;
  const all = useMemo(
    () => (countries ? prepareAirspaces(countries, lat != null && lng != null ? { lat, lng } : null) : NONE),
    [countries, lat, lng],
  );
  const status = useMemo(() => (countries ? airspaceStatus(countries) : EMPTY_STATUS), [countries]);

  return {
    airspaces: enabled ? all : NONE,
    status,
    loading: enabled && countries === null && error === null,
    error,
    reload,
  };
}

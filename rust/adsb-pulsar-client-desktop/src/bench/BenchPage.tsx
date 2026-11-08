"use client";
/**
 * Shell for one benchmark variant. Bench routes exist only in BENCH=1 builds
 * (see `pageExtensions` in next.config.ts); the shipped app never contains them.
 */
import { useEffect, useState, type ComponentType } from "react";
import { parseParams, type BenchParams } from "./harness";
import type { Variant } from "./stats";

const LOADERS: Record<Variant, () => Promise<{ default: ComponentType<{ params: BenchParams }> }>> = {
  leaflet: () => import("./variants/LeafletBaseline"),
  deckgl: () => import("./variants/DeckGlLeaflet"),
  maplibre: () => import("./variants/MapLibre"),
  openlayers: () => import("./variants/OpenLayers"),
};

export function BenchPage({ variant }: { variant: Variant }) {
  const [state, setState] = useState<{ Comp: ComponentType<{ params: BenchParams }>; params: BenchParams } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Recorded, not fatal: the root layout's providers are not part of what is
    // measured. Only a bad query string or a variant that fails to load aborts.
    const onError = (e: ErrorEvent | PromiseRejectionEvent) => {
      const msg = "reason" in e ? String(e.reason) : e.message;
      (window.__benchPageErrors ??= []).push(msg);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onError);
    let params: BenchParams;
    try {
      params = parseParams(window.location.search);
    } catch (e) {
      window.__benchError = String(e);
      setError(String(e)); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }
    LOADERS[variant]()
      .then((m) => setState({ Comp: m.default, params }))
      .catch((e) => {
        window.__benchError = String(e);
        setError(String(e));
      });
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onError);
    };
  }, [variant]);

  if (error) return <pre style={{ color: "red" }}>{error}</pre>;
  if (!state) return null;
  const { Comp, params } = state;
  return <Comp params={params} />;
}

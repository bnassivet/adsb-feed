"use client";
/**
 * MapLibre as the map; data drawn by deck.gl through the official
 * `MapboxOverlay`. Same deck layers as the Leaflet and OpenLayers deck
 * variants, so flat mode isolates the basemap engine.
 *
 * Pitched mode is the reason to consider MapLibre at all: a 60° tilted view with
 * every position at its true altitude. Not directly comparable to the flat
 * variants: the tilted view shows more of the data, further away.
 *
 * The 3D-scene options:
 * - `interleaved`: deck draws inside MapLibre's render pass and shares its depth
 *   buffer, so terrain and buildings can hide aircraft behind them. Overlaid
 *   (the default) draws on a separate canvas on top of everything.
 * - `terrain` / `buildings`: real tiles from bench/fixtures/ (see
 *   maplibre-style.ts). The page waits for the map's first `idle` before the
 *   bench starts, so `initial` times the aircraft data, not the tile load.
 */
import { useEffect, useRef } from "react";
import { Map as MlMap, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { installBench, BENCH_VIEW, type BenchParams } from "../harness";
import { benchStyle, CITY_VIEW } from "../maplibre-style";
import { exposeTransform } from "../maplibre-compat";
import { buildLayers } from "./DeckGlLeaflet";

export const PITCH_3D = 60;

export interface MapLibreDeckGlOptions {
  pitched: boolean;
  interleaved?: boolean;
  terrain?: boolean;
  buildings?: boolean;
  /** "default" is BENCH_VIEW (zoom 7, the receiver's range); "city" is downtown Montréal at zoom 15. */
  view?: "default" | "city";
}

export function MapLibreDeckGlVariant({ params, ...opts }: { params: BenchParams } & MapLibreDeckGlOptions) {
  const el = useRef<HTMLDivElement>(null);
  const { pitched, interleaved = false, terrain = false, buildings = false, view = "default" } = opts;

  useEffect(() => {
    if (!el.current) return;
    setWorkerUrl(new URL("/vendor/maplibre/maplibre-gl-worker.mjs", window.location.href).href);
    const live = params.scenario === "live";
    const v = view === "city" ? CITY_VIEW : BENCH_VIEW;
    const map = new MlMap({
      container: el.current,
      style: benchStyle({ base: window.location.origin, terrain, buildings }),
      center: [v.center[1], v.center[0]],
      zoom: v.maplibreZoom,
      pitch: pitched ? PITCH_3D : 0,
      attributionControl: false,
    });
    let pending: (() => void) | null = null;
    const overlay = new MapboxOverlay({
      interleaved,
      layers: [],
      onAfterRender: () => {
        pending?.();
        pending = null;
      },
    });

    map.on("load", () => {
      exposeTransform(map);
      map.addControl(overlay);
      map.once("idle", () =>
        installBench(
          {
            setData: (tracks, style) =>
              new Promise<void>((resolve) => {
                pending = resolve;
                overlay.setProps({ layers: buildLayers(tracks, style, live, pitched) });
              }),
            onMoveEnd: (cb) => {
              map.on("moveend", cb);
              return () => map.off("moveend", cb);
            },
          },
          params,
        ),
      );
    });
    return () => map.remove();
  }, [params, pitched, interleaved, terrain, buildings, view]);

  return <div ref={el} style={{ position: "fixed", inset: 0, background: "#111" }} />;
}

export default function MapLibreDeckGl({ params }: { params: BenchParams }) {
  return <MapLibreDeckGlVariant params={params} pitched={false} />;
}

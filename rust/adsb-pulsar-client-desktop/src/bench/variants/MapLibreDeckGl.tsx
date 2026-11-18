"use client";
/**
 * MapLibre as the map; data drawn by deck.gl through the official
 * `MapboxOverlay` (overlaid mode: deck's own canvas, synced to MapLibre's
 * camera — the same arrangement as the Leaflet and OpenLayers deck variants).
 * Same deck layers as those, so flat mode isolates the basemap engine.
 *
 * Pitched mode is the reason to consider MapLibre at all: a 60° tilted view with
 * every position at its true altitude. Not directly comparable to the flat
 * variants: the tilted view shows more of the data, further away.
 */
import { useEffect, useRef } from "react";
import { Map as MlMap, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { installBench, BENCH_VIEW, type BenchParams } from "../harness";
import { buildLayers } from "./DeckGlLeaflet";

export const PITCH_3D = 60;

export function MapLibreDeckGlVariant({ params, pitched }: { params: BenchParams; pitched: boolean }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!el.current) return;
    setWorkerUrl(new URL("/vendor/maplibre/maplibre-gl-worker.mjs", window.location.href).href);
    const live = params.scenario === "live";
    const map = new MlMap({
      container: el.current,
      style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#111" } }] },
      center: [BENCH_VIEW.center[1], BENCH_VIEW.center[0]],
      zoom: BENCH_VIEW.maplibreZoom,
      pitch: pitched ? PITCH_3D : 0,
      attributionControl: false,
    });
    let pending: (() => void) | null = null;
    const overlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
      onAfterRender: () => {
        pending?.();
        pending = null;
      },
    });

    map.on("load", () => {
      map.addControl(overlay);
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
      );
    });
    return () => map.remove();
  }, [params, pitched]);

  return <div ref={el} style={{ position: "fixed", inset: 0, background: "#111" }} />;
}

export default function MapLibreDeckGl({ params }: { params: BenchParams }) {
  return <MapLibreDeckGlVariant params={params} pitched={false} />;
}

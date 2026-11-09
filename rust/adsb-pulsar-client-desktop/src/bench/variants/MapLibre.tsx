"use client";
/** MapLibre GL: GeoJSON sources, circle/line layers, colour computed on the GPU by expression. */
import { useEffect, useRef } from "react";
import { Map as MlMap, setWorkerUrl, type GeoJSONSource, type ExpressionSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { flatten } from "../flatten";
import { ALTITUDE_STOPS, LINE_RGB } from "../color";
import { installBench, BENCH_VIEW, type BenchParams } from "../harness";
import type { AircraftTrack } from "@/lib/types";
import type { Style } from "../stats";

const rgb = ([r, g, b]: readonly number[]) => `rgb(${r},${g},${b})`;

/** Negative altitude encodes "unknown" (expressions and null do not mix well). */
const ALT_COLOR: ExpressionSpecification = [
  "case",
  ["<", ["get", "alt"], 0], "#888888",
  ["interpolate", ["linear"], ["get", "alt"], ...ALTITUDE_STOPS.flatMap(([a, c]) => [a, rgb(c)])],
] as unknown as ExpressionSpecification;

type FC = GeoJSON.FeatureCollection;
const EMPTY: FC = { type: "FeatureCollection", features: [] };

function toGeoJSON(tracks: AircraftTrack[], style: Style): { data: FC; heads: FC } {
  const f = flatten(tracks);
  const features: GeoJSON.Feature[] = [];
  if (style === "dots") {
    for (let i = 0; i < f.count; i++) {
      features.push({
        type: "Feature",
        properties: { alt: Number.isNaN(f.alt[i]) ? -1 : f.alt[i] },
        geometry: { type: "Point", coordinates: [f.lng[i], f.lat[i]] },
      });
    }
  } else {
    for (let t = 0; t + 1 < f.starts.length; t++) {
      const coords: number[][] = [];
      for (let i = f.starts[t]; i < f.starts[t + 1]; i++) coords.push([f.lng[i], f.lat[i]]);
      features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });
    }
  }
  const heads: GeoJSON.Feature[] = Array.from(f.heads, (h) => ({
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [f.lng[h], f.lat[h]] },
  }));
  return { data: { type: "FeatureCollection", features }, heads: { type: "FeatureCollection", features: heads } };
}

export default function MapLibre({ params }: { params: BenchParams }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!el.current) return;
    // MapLibre 6 resolves its worker relative to its own script, which webpack
    // rewrites into the page URL. bench/run.mjs serves the real file here.
    setWorkerUrl(new URL("/vendor/maplibre/maplibre-gl-worker.mjs", window.location.href).href);
    const live = params.scenario === "live";
    const map = new MlMap({
      container: el.current,
      style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#111" } }] },
      center: [BENCH_VIEW.center[1], BENCH_VIEW.center[0]],
      zoom: BENCH_VIEW.maplibreZoom,
      attributionControl: false,
    });

    map.on("load", () => {
      map.addSource("data", { type: "geojson", data: EMPTY });
      map.addSource("heads", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "dots", type: "circle", source: "data", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": live ? 3 : 2.5, "circle-color": ALT_COLOR, "circle-opacity": live ? 0.6 : 0.4 },
      });
      map.addLayer({
        id: "lines", type: "line", source: "data", filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": rgb(LINE_RGB), "line-width": 2, "line-opacity": 0.5 },
      });
      if (live) {
        map.addLayer({ id: "heads", type: "circle", source: "heads", paint: { "circle-radius": 5, "circle-color": "#fff" } });
      }

      installBench(
        {
          setData: (tracks, style) => {
            const { data, heads } = toGeoJSON(tracks, style);
            const idle = new Promise<void>((r) => map.once("idle", () => r()));
            (map.getSource("data") as GeoJSONSource).setData(data);
            if (live) (map.getSource("heads") as GeoJSONSource).setData(heads);
            return idle;
          },
          onMoveEnd: (cb) => {
            map.on("moveend", cb);
            return () => map.off("moveend", cb);
          },
        },
        params,
      );
    });
    return () => map.remove();
  }, [params]);

  return <div ref={el} style={{ position: "fixed", inset: 0, background: "#111" }} />;
}

"use client";
/** OpenLayers with GPU rendering: WebGLVectorLayer, flat styles, colour by GPU expression. */
import { useEffect, useRef } from "react";
import OlMap from "ol/Map.js";
import View from "ol/View.js";
import Feature from "ol/Feature.js";
import Point from "ol/geom/Point.js";
import LineString from "ol/geom/LineString.js";
import VectorSource from "ol/source/Vector.js";
import WebGLVectorLayer from "ol/layer/WebGLVector.js";
import type { FlatStyle } from "ol/style/flat.js";
import "ol/ol.css";
import { flatten, toMercator } from "../flatten";
import { ALTITUDE_STOPS, LINE_RGB } from "../color";
import { installBench, BENCH_VIEW, type BenchParams } from "../harness";
import type { AircraftTrack } from "@/lib/types";
import type { Style } from "../stats";

function dotStyle(opacity: number, radius: number): FlatStyle {
  return {
    "circle-radius": radius,
    "circle-fill-color": [
      "case",
      ["<", ["get", "alt"], 0], [136, 136, 136, opacity],
      ["interpolate", ["linear"], ["get", "alt"], ...ALTITUDE_STOPS.flatMap(([a, c]) => [a, [...c, opacity]])],
    ],
  } as FlatStyle;
}

const LINE_STYLE: FlatStyle = { "stroke-color": [...LINE_RGB, 0.5], "stroke-width": 2 };
const HEAD_STYLE: FlatStyle = { "circle-radius": 5, "circle-fill-color": [255, 255, 255, 0.9] };

function toFeatures(tracks: AircraftTrack[], style: Style): { data: Feature[]; heads: Feature[] } {
  const f = flatten(tracks);
  const data: Feature[] = [];
  if (style === "dots") {
    for (let i = 0; i < f.count; i++) {
      data.push(new Feature({
        geometry: new Point(toMercator(f.lng[i], f.lat[i])),
        alt: Number.isNaN(f.alt[i]) ? -1 : f.alt[i],
      }));
    }
  } else {
    for (let t = 0; t + 1 < f.starts.length; t++) {
      const coords: number[][] = [];
      for (let i = f.starts[t]; i < f.starts[t + 1]; i++) coords.push(toMercator(f.lng[i], f.lat[i]));
      data.push(new Feature({ geometry: new LineString(coords) }));
    }
  }
  const heads = Array.from(f.heads, (h) => new Feature({ geometry: new Point(toMercator(f.lng[h], f.lat[h])) }));
  return { data, heads };
}

export default function OpenLayers({ params }: { params: BenchParams }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!el.current) return;
    const live = params.scenario === "live";
    const source = new VectorSource();
    const headSource = new VectorSource();
    const layer = new WebGLVectorLayer({
      source,
      style: params.style === "dots" ? dotStyle(live ? 0.6 : 0.4, live ? 3 : 2.5) : LINE_STYLE,
    });
    const layers = [layer];
    if (live) layers.push(new WebGLVectorLayer({ source: headSource, style: HEAD_STYLE }));

    const map = new OlMap({
      target: el.current,
      layers,
      view: new View({
        center: toMercator(BENCH_VIEW.center[1], BENCH_VIEW.center[0]),
        zoom: BENCH_VIEW.zoom,
      }),
    });

    installBench(
      {
        setData: (tracks, style) => {
          const { data, heads } = toFeatures(tracks, style);
          const done = new Promise<void>((r) => map.once("rendercomplete", () => r()));
          source.clear(true);
          source.addFeatures(data);
          if (live) {
            headSource.clear(true);
            headSource.addFeatures(heads);
          }
          map.render();
          return done;
        },
        onMoveEnd: (cb) => {
          map.on("moveend", cb);
          return () => map.un("moveend", cb);
        },
      },
      params,
    );
    return () => {
      map.setTarget(undefined);
      map.dispose();
    };
  }, [params]);

  return <div ref={el} style={{ position: "fixed", inset: 0, background: "#111" }} />;
}

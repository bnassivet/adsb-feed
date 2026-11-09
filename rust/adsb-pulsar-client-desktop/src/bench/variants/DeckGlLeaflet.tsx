"use client";
/** Leaflet kept as the map; dots and lines drawn by deck.gl through the vendored overlay (src/lib/deck-leaflet). */
import { useEffect, useRef } from "react";
import L from "leaflet";
import { DeckLayer } from "@/lib/deck-leaflet/leaflet-layer";
import type { Layer } from "@deck.gl/core";
import { ScatterplotLayer, PathLayer } from "@deck.gl/layers";
import { flatten } from "../flatten";
import { altitudeRgb, LINE_RGB } from "../color";
import { installBench, BENCH_VIEW, type BenchParams } from "../harness";
import type { AircraftTrack } from "@/lib/types";
import type { Style } from "../stats";

function buildLayers(tracks: AircraftTrack[], style: Style, live: boolean): Layer[] {
  const f = flatten(tracks);
  const pos = new Float32Array(f.count * 2);
  for (let i = 0; i < f.count; i++) {
    pos[2 * i] = f.lng[i];
    pos[2 * i + 1] = f.lat[i];
  }
  const layers: Layer[] = [];

  if (style === "dots") {
    const col = new Uint8Array(f.count * 4);
    const alpha = Math.round((live ? 0.6 : 0.4) * 255);
    for (let i = 0; i < f.count; i++) {
      const [r, g, b] = altitudeRgb(f.alt[i]);
      col[4 * i] = r; col[4 * i + 1] = g; col[4 * i + 2] = b; col[4 * i + 3] = alpha;
    }
    layers.push(new ScatterplotLayer({
      id: "dots",
      data: { length: f.count, attributes: { getPosition: { value: pos, size: 2 }, getFillColor: { value: col, size: 4, normalized: true } } },
      radiusUnits: "pixels",
      getRadius: live ? 3 : 2.5,
      stroked: false,
      pickable: true,
    }));
  } else {
    layers.push(new PathLayer({
      id: "lines",
      data: { length: f.starts.length - 1, startIndices: f.starts, attributes: { getPath: { value: pos, size: 2 } } },
      _pathType: "open",
      getColor: [...LINE_RGB, 128],
      widthUnits: "pixels",
      getWidth: 2,
      pickable: true,
    }));
  }

  if (live) {
    const hp = new Float32Array(f.heads.length * 2);
    f.heads.forEach((h, i) => { hp[2 * i] = f.lng[h]; hp[2 * i + 1] = f.lat[h]; });
    layers.push(new ScatterplotLayer({
      id: "heads",
      data: { length: f.heads.length, attributes: { getPosition: { value: hp, size: 2 } } },
      radiusUnits: "pixels",
      getRadius: 5,
      getFillColor: [255, 255, 255, 230],
      pickable: true,
    }));
  }
  return layers;
}

export default function DeckGlLeaflet({ params }: { params: BenchParams }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!el.current) return;
    const map = L.map(el.current, { center: BENCH_VIEW.center, zoom: BENCH_VIEW.zoom, preferCanvas: true });
    let pending: (() => void) | null = null;
    const deck = new DeckLayer({
      layers: [],
      onAfterRender: () => {
        pending?.();
        pending = null;
      },
    });
    map.addLayer(deck);
    const live = params.scenario === "live";

    installBench(
      {
        setData: (tracks, style) =>
          new Promise<void>((resolve) => {
            pending = resolve;
            deck.setProps({ layers: buildLayers(tracks, style, live) });
          }),
        onMoveEnd: (cb) => {
          map.on("moveend", cb);
          return () => map.off("moveend", cb);
        },
      },
      params,
    );
    return () => {
      map.remove();
    };
  }, [params]);

  return <div ref={el} style={{ position: "fixed", inset: 0, background: "#111" }} />;
}

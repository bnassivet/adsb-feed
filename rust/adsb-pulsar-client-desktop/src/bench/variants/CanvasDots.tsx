"use client";
/**
 * Leaflet kept as the map; dots and lines drawn from typed arrays onto ONE
 * Leaflet canvas (src/lib/canvas-dots*.ts) — no GPU, no per-point objects.
 * Tests whether the baseline's cost is the objects rather than the drawing.
 */
import { useEffect, useRef } from "react";
import L from "leaflet";
import { buildDotBuckets, worldPx, ALT_BIN_FT, NULL_BIN } from "@/lib/canvas-dots";
import { CanvasDotsRenderer, type PathSet } from "@/lib/canvas-dots-layer";
import { flatten } from "../flatten";
import { altitudeRgb, LINE_RGB } from "../color";
import { installBench, BENCH_VIEW, type BenchParams } from "../harness";
import type { AircraftTrack } from "@/lib/types";
import type { Style } from "../stats";

const rgb = ([r, g, b]: readonly number[]) => `rgb(${r},${g},${b})`;
const colorOfBin = (bin: number) => rgb(altitudeRgb(bin === NULL_BIN ? null : (bin + 0.5) * ALT_BIN_FT));

function toPaths(f: ReturnType<typeof flatten>): PathSet {
  const x = new Float64Array(f.count);
  const y = new Float64Array(f.count);
  for (let i = 0; i < f.count; i++) [x[i], y[i]] = worldPx(f.lat[i], f.lng[i]);
  return { x, y, starts: f.starts };
}

function render(r: CanvasDotsRenderer, tracks: AircraftTrack[], style: Style, live: boolean) {
  const f = flatten(tracks);
  if (style === "dots") {
    r.setLines(null, { color: "", width: 0, alpha: 0 });
    r.setDots(buildDotBuckets(f.lat, f.lng, f.alt), { radius: live ? 3 : 2.5, alpha: live ? 0.6 : 0.4, colorOfBin });
  } else {
    r.setDots(null, { radius: 0, alpha: 0, colorOfBin });
    r.setLines(toPaths(f), { color: rgb(LINE_RGB), width: 2, alpha: 0.5 });
  }
  if (live) {
    const hx = new Float64Array(f.heads.length);
    const hy = new Float64Array(f.heads.length);
    f.heads.forEach((h, i) => ([hx[i], hy[i]] = worldPx(f.lat[h], f.lng[h])));
    r.setHeads(hx, hy, 5, "#fff");
  }
}

export default function CanvasDots({ params }: { params: BenchParams }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!el.current) return;
    const renderer = new CanvasDotsRenderer({ padding: 0.1 });
    const map = L.map(el.current, { center: BENCH_VIEW.center, zoom: BENCH_VIEW.zoom, renderer });
    map.addLayer(renderer);
    const live = params.scenario === "live";

    installBench(
      {
        // Drawing is synchronous, so "rendered" is when render() returns.
        setData: async (tracks, style) => render(renderer, tracks, style, live),
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

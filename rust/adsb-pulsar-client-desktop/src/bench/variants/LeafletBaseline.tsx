"use client";
/**
 * Baseline: the shipping `MapInner`, unmodified. DB-history tracks for the batch
 * scenarios, live tracks for `live` — the same props the app passes.
 */
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { MapInner } from "@/components/MapInner";
import type { AircraftTrack } from "@/lib/types";
import { installBench, nextFrame, type BenchParams } from "../harness";
import type { Style } from "../stats";

// MapInner does not expose its map; capture it as Leaflet constructs it.
let lastMap: L.Map | null = null;
const captureMap = (m: L.Map) => {
  lastMap = m;
};
L.Map.addInitHook(function (this: L.Map) {
  captureMap(this);
});

const NO_SELECTION = new Set<string>();
const noop = () => {};

export default function LeafletBaseline({ params }: { params: BenchParams }) {
  const [data, setData] = useState<{ tracks: AircraftTrack[]; style: Style; version: number }>({
    tracks: [], style: params.style, version: 0,
  });
  const pending = useRef<(() => void) | null>(null);

  // Parent effects run after every child's, so by now DotsLayer/Polylines have
  // built their Leaflet layers for this version.
  useEffect(() => {
    pending.current?.();
    pending.current = null;
  }, [data.version]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      while (!lastMap && !cancelled) await nextFrame();
      if (cancelled || !lastMap) return;
      const map = lastMap;
      installBench(
        {
          setData: (tracks, style) =>
            new Promise<void>((resolve) => {
              pending.current = resolve;
              setData((d) => ({ tracks, style, version: d.version + 1 }));
            }),
          onMoveEnd: (cb) => {
            map.on("moveend", cb);
            return () => map.off("moveend", cb);
          },
        },
        params,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [params]);

  const live = params.scenario === "live";
  // Bench-only switch for reproducing label behaviour (`?labels=1`); off for measurements.
  const showLabels = typeof location !== "undefined" && new URLSearchParams(location.search).get("labels") === "1";
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <MapInner
        tracks={live ? data.tracks : []}
        historyTracks={[]}
        dbHistoryTracks={live ? [] : data.tracks}
        mapTheme="dark"
        onToggleTheme={noop}
        trajectoryStyle={data.style}
        showPositions
        showLabels={showLabels}
        showDensity={false}
        densityMetric="positions"
        densityTracks={[]}
        densityAltitudeMin={0}
        densityAltitudeMax={50_000}
        densityTooltipMode="off"
        liveColorMode="plot"
        historyColorMode="plot"
        selectedHexIdents={NO_SELECTION}
        onSelectTrack={noop}
      />
    </div>
  );
}

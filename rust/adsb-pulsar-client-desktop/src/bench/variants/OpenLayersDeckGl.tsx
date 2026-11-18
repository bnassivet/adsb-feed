"use client";
/**
 * OpenLayers kept as the map; dots and lines drawn by deck.gl inside a custom
 * OL layer whose `render` syncs deck's view to OL's frame (deck.gl's documented
 * OpenLayers pattern). Same deck layers as the Leaflet+deck.gl variant, so the
 * difference between the two is the basemap engine alone.
 */
import { useEffect, useRef } from "react";
import OlMap from "ol/Map.js";
import View from "ol/View.js";
import Layer from "ol/layer/Layer.js";
import "ol/ol.css";
import { Deck } from "@deck.gl/core";
import { toMercator } from "../flatten";
import { olToDeckViewState } from "../deck-ol-view";
import { installBench, BENCH_VIEW, type BenchParams } from "../harness";
import { buildLayers } from "./DeckGlLeaflet";

export default function OpenLayersDeckGl({ params }: { params: BenchParams }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!el.current) return;
    const live = params.scenario === "live";
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
    let pending: (() => void) | null = null;
    const center = toMercator(BENCH_VIEW.center[1], BENCH_VIEW.center[0]);
    const deck = new Deck({
      canvas,
      controller: false,
      viewState: olToDeckViewState(center, BENCH_VIEW.zoom, 0),
      layers: [],
      onAfterRender: () => {
        pending?.();
        pending = null;
      },
    });
    const deckLayer = new Layer({
      render: (frameState) => {
        const [width, height] = frameState.size;
        const v = frameState.viewState;
        deck.setProps({ width, height, viewState: olToDeckViewState(v.center, v.zoom, v.rotation) });
        deck.redraw("ol-frame");
        return canvas;
      },
    });
    const map = new OlMap({
      target: el.current,
      layers: [deckLayer],
      view: new View({ center, zoom: BENCH_VIEW.zoom }),
    });

    installBench(
      {
        setData: (tracks, style) =>
          new Promise<void>((resolve) => {
            pending = resolve;
            deck.setProps({ layers: buildLayers(tracks, style, live) });
            map.render();
          }),
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
      deck.finalize();
    };
  }, [params]);

  return <div ref={el} style={{ position: "fixed", inset: 0, background: "#111" }} />;
}

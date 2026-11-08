"use client";
/**
 * Every dot set on the map (live, history, DB History, imported), drawn on the
 * GPU by one deck.gl overlay. Replaces the old `DotsLayer`, which created one
 * `L.CircleMarker` per point and rebuilt them all on every pan or zoom
 * (docs/MAP_BENCH.md: 0.3 s freezes at 200k points, 1.8 s at 1M).
 *
 * - **One `Deck`, one WebGL context**, in its own pane at z-index 450: above
 *   Leaflet's vector canvas (density, range lines, polylines) and below the
 *   aircraft icons (markerPane, 600).
 * - **Buffers are cached per set** by `(tracks, colorMode, theme)` identity. A
 *   live update rebuilds only the live set, and deck.gl sees the same `data`
 *   object for the others, so it uploads nothing for them.
 * - **Selection** is a small extra layer per set, holding only the selected
 *   tracks and drawn bigger and more opaque above that set. Selecting a track
 *   doesn't touch the big buffers.
 * - **Hover** runs `pickObject` on the map's own `mousemove`. The deck canvas
 *   has `pointer-events: none`, so dragging, clicks and the context menu stay
 *   Leaflet's.
 */
import { useEffect, useRef } from "react";
import L from "leaflet";
import { useMap } from "react-leaflet";
import type { Layer } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import { DeckLayer } from "@/lib/deck-leaflet/leaflet-layer";
import { buildDotBuffers, locateDot, type DotBuffers } from "@/lib/deck-dots";
import { dotTooltipHtml, type DotSetType } from "@/lib/dot-tooltip";
import { isBareMapTarget } from "@/lib/map-hover-target";
import type { MapTheme } from "@/lib/colors";
import type { AircraftTrack, AltitudeColorMode } from "@/lib/types";

export interface DotSet {
  type: DotSetType;
  tracks: AircraftTrack[];
  colorMode: AltitudeColorMode;
}

/** Radius (px) and opacity per set, unchanged from `DotsLayer`. */
const STYLE: Record<DotSetType, { radius: number; alpha: number }> = {
  history: { radius: 2, alpha: 0.2 },
  imported: { radius: 2.5, alpha: 0.35 },
  dbHistory: { radius: 2.5, alpha: 0.4 },
  live: { radius: 3, alpha: 0.6 },
};
const SELECTED_ALPHA = 0.9;
const SELECTED_EXTRA_RADIUS = 2;
const PANE = "deckDots";
const PICK_RADIUS_PX = 3;

interface Cached {
  key: readonly unknown[];
  buf: DotBuffers;
  /** Stable identity: deck.gl re-uploads attributes only when `data` changes. */
  data: { length: number; attributes: Record<string, { value: Float32Array | Uint8Array; size: number; normalized?: boolean }> };
}

function sameKey(a: readonly unknown[], b: readonly unknown[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function cached(cache: Map<string, Cached>, id: string, key: readonly unknown[], build: () => DotBuffers): Cached {
  const hit = cache.get(id);
  if (hit && sameKey(hit.key, key)) return hit;
  const buf = build();
  const entry: Cached = {
    key,
    buf,
    data: {
      length: buf.length,
      attributes: {
        getPosition: { value: buf.positions, size: 2 },
        getFillColor: { value: buf.colors, size: 4, normalized: true },
      },
    },
  };
  cache.set(id, entry);
  return entry;
}

export function DeckDotsOverlay({ sets, selected, theme }: { sets: DotSet[]; selected: Set<string>; theme: MapTheme }) {
  const map = useMap();
  const deckRef = useRef<DeckLayer | null>(null);
  const cacheRef = useRef(new Map<string, Cached>());
  /** Layer id → what it draws, for hover lookup. */
  const pickables = useRef(new Map<string, { type: DotSetType; buf: DotBuffers }>());

  // The overlay, its pane, and hover picking: once per map.
  useEffect(() => {
    const pane = map.getPane(PANE) ?? map.createPane(PANE);
    pane.style.zIndex = "450";
    pane.style.pointerEvents = "none";
    const deck = new DeckLayer({ layers: [], style: { pointerEvents: "none" } }, { pane: PANE });
    map.addLayer(deck);
    deckRef.current = deck;

    const tooltip = L.tooltip({ direction: "auto", opacity: 0.9 });
    let shown: string | null = null;
    let moving = false;
    let frame = 0;
    let last: L.Point | null = null;

    const hide = () => {
      if (shown !== null) tooltip.remove();
      shown = null;
      map.getContainer().style.cursor = "";
    };
    const pick = () => {
      frame = 0;
      if (!last || moving) return;
      const info = deck.pickObject({ x: last.x, y: last.y, radius: PICK_RADIUS_PX });
      const owner = info?.layer ? pickables.current.get(info.layer.id) : undefined;
      const dot = owner && info ? locateDot(owner.buf, info.index) : null;
      if (!owner || !dot) return hide();
      const id = `${info!.layer!.id}:${info!.index}`;
      map.getContainer().style.cursor = "pointer";
      if (id === shown) return;
      tooltip
        .setLatLng([dot.lat, dot.lng])
        .setContent(dotTooltipHtml(owner.type, dot.track, dot.alt, dot.isLast));
      if (shown === null) tooltip.addTo(map);
      shown = id;
    };
    const onMove = (e: L.LeafletMouseEvent) => {
      // Over an aircraft icon (or a tooltip, popup, control) that element owns the hover.
      if (!isBareMapTarget(e.originalEvent.target, map.getContainer())) {
        last = null;
        return hide();
      }
      last = e.containerPoint;
      if (!frame) frame = requestAnimationFrame(pick);
    };
    const onStart = () => {
      moving = true;
      hide();
    };
    const onEnd = () => {
      moving = false;
    };
    const onOut = () => {
      last = null;
      hide();
    };
    map.on("mousemove", onMove);
    map.on("mouseout", onOut);
    map.on("movestart zoomstart", onStart);
    map.on("moveend zoomend", onEnd);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      map.off("mousemove", onMove);
      map.off("mouseout", onOut);
      map.off("movestart zoomstart", onStart);
      map.off("moveend zoomend", onEnd);
      hide();
      map.removeLayer(deck);
      deckRef.current = null;
    };
  }, [map]);

  // Layers: rebuilt every render, but from cached buffers.
  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;
    const cache = cacheRef.current;
    const layers: Layer[] = [];
    const live = new Set<string>();
    pickables.current.clear();

    for (const { type, tracks, colorMode } of sets) {
      const { radius, alpha } = STYLE[type];
      const base = cached(cache, type, [tracks, colorMode, theme], () =>
        buildDotBuffers(tracks, { colorMode, theme, alpha }),
      );
      const sel = cached(cache, `${type}-selected`, [tracks, colorMode, theme, selected], () =>
        buildDotBuffers(tracks, { colorMode, theme, alpha: SELECTED_ALPHA, only: selected }),
      );
      for (const [id, entry, r] of [[type, base, radius], [`${type}-selected`, sel, radius + SELECTED_EXTRA_RADIUS]] as const) {
        live.add(id);
        if (entry.buf.length === 0) continue;
        pickables.current.set(id, { type, buf: entry.buf });
        layers.push(
          new ScatterplotLayer({
            id,
            data: entry.data,
            radiusUnits: "pixels",
            getRadius: r,
            stroked: false,
            pickable: true,
          }),
        );
      }
    }
    // Drop buffers of sets no longer shown, so their memory can go.
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
    deck.setProps({ layers });
  }, [sets, selected, theme]);

  return null;
}

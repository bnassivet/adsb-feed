"use client";
import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { MapContainer, Marker, Polyline, GeoJSON, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { routeLegs, type AgentTrajectory } from "@/lib/simulation-data";
import L from "leaflet";
import type { AircraftTrack, DensityMetric, DensityTooltipMode, AltitudeColorMode, EventOfInterest, MapPickResult, Positions } from "@/lib/types";
import { zoomToH3Resolution, trackKey, cornersToBox, isColumnar } from "@/lib/types";
import { altitudeToColor, densityColor, cachedAltitudeToColor, type MapTheme } from "@/lib/colors";
import { computeH3Density } from "@/lib/h3-density";
import { buildDensityTooltip } from "@/lib/density-tooltip";
import type { DensityProperties, DensityAltitudeRange } from "@/lib/h3-density";
import { useMapZoom } from "@/hooks/useMapZoom";
import { aircraftIconHtml } from "@/lib/aircraft-icon";
import { orderTracksWithSelectedLast } from "@/lib/track-ordering";
import { formatAlt, timeAgo } from "@/lib/dot-tooltip";
import { DeckDotsOverlay, type DotSet } from "./DeckDotsOverlay";
import { formatTrackLabel, layoutLabels, trackLabelHtml, type LabelItem, type LabelPlacement } from "@/lib/label-layout";
import {
  fieldsAt,
  gridPoints,
  levelLabel,
  windAtPoint,
  type WeatherLevel,
  type WeatherSnapshot,
} from "@/lib/weather";
import { windBarbSvg } from "@/lib/wind-barb";
import {
  createParticles,
  createWindField,
  degreesPerPixel,
  fieldBounds,
  intersectBounds,
  PARTICLE_COLORS,
  particleCount,
  projectMercator,
  speedBucket,
  stepParticles,
  type GeoBounds,
  type Particles,
} from "@/lib/wind-particles";
import { formatWind } from "@/lib/wind-format";
import { CARTO_API_KEY, tileConfig, type TileConfig } from "@/lib/basemap";
import { createCachedTileLayer, type CacheContext } from "@/lib/tile-cache/CachedTileLayer";
import { sharedTileStore } from "@/lib/tile-cache/shared";
import { recordStoreFailure } from "@/lib/tile-cache/health";
import { useTileCacheSettings } from "@/hooks/useTileCacheSettings";
import { MapTileToggle } from "./MapTileToggle";

import { CenterOnAntennaButton } from "./CenterOnAntennaButton";
import { RangeLineButton, RANGE_LINE_COLOR } from "./RangeLineButton";
import { greatCirclePoints, midpoint, rangeLineLabel } from "@/lib/range-line";
import type { ReceiverPoint } from "@/lib/aircraft-details";
import { AltitudeLegend } from "./AltitudeLegend";
import { WindSpeedLegend } from "./WindSpeedLegend";

/**
 * Per-leg colours for a generated route.
 *
 * A multi-leg route is a sequence of distinct intentions — get there, work the
 * area, leave — and drawn in one colour they are indistinguishable. Cycled by
 * leg index, so a single-leg route keeps the original blue.
 */
const SIM_LEG_COLORS = ["#38bdf8", "#a78bfa", "#fbbf24", "#34d399", "#f472b6", "#fb7185"];

// Default center: Montreal
const DEFAULT_CENTER: [number, number] = [45.5, -73.6];
const DEFAULT_ZOOM = 8;

/** Creates a rotated triangle SVG DivIcon for an aircraft, with optional selection ring. */
function aircraftIcon(heading: number, color: string, selected: boolean = false): L.DivIcon {
  const result = aircraftIconHtml(heading, color, selected);
  return L.divIcon({
    html: result.html,
    className: result.className,
    iconSize: result.iconSize,
    iconAnchor: result.iconAnchor,
  });
}

/** Watches container size changes and tells Leaflet to recalculate. */
function MapResizeHandler() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);

  return null;
}

/** Deselects when clicking empty map space (marker clicks don't propagate to map). */
function MapClickHandler({ onDeselect }: { onDeselect: () => void }) {
  useMapEvents({
    click: () => onDeselect(),
  });
  return null;
}

/** Captures map right-click and passes lat/lng + pixel position to parent. */
function ContextMenuHandler({ onContextMenu }: { onContextMenu: (lat: number, lng: number, x: number, y: number) => void }) {
  useMapEvents({
    contextmenu: (e) => {
      const { lat, lng } = e.latlng;
      const point = e.containerPoint;
      onContextMenu(lat, lng, point.x, point.y);
    },
  });
  return null;
}

/** Registers a flyTo callback so external code (e.g. copilot tools) can navigate the map. */
function FlyToHandler({ onReady }: { onReady?: (fn: (lat: number, lng: number, zoom: number) => void) => void }) {
  const map = useMap();
  useEffect(() => {
    if (onReady) {
      onReady((lat, lng, zoom) => map.flyTo([lat, lng], zoom));
    }
  }, [map, onReady]);
  return null;
}

/** Renders event-of-interest markers imperatively via Leaflet API. */
function EventMarkersLayer({ events, theme }: { events: EventOfInterest[]; theme: "light" | "dark" }) {
  const map = useMap();

  useEffect(() => {
    const layers: L.Layer[] = [];

    for (const ev of events) {
      // Point event marker
      if (ev.latitude != null && ev.longitude != null) {
        const marker = L.circleMarker([ev.latitude, ev.longitude], {
          radius: 7,
          color: "#f59e0b",
          fillColor: "#f59e0b",
          fillOpacity: 0.6,
          weight: 2,
        });

        const time = new Date(ev.timestamp_ms).toLocaleString();
        const catLine = ev.category ? `<div>Category: <span style="color:#fff">${ev.category}</span></div>` : "";
        marker.bindTooltip(() =>
          `<div style="font-weight:600;color:#f59e0b">${ev.title}</div>${catLine}<div>${time}</div><div style="color:#94a3b8;margin-top:2px;font-style:italic">Event of Interest</div>`
        );

        marker.addTo(map);
        layers.push(marker);
      }

      // Area event rectangle
      if (ev.bbox_north != null && ev.bbox_south != null && ev.bbox_east != null && ev.bbox_west != null) {
        const rect = L.rectangle(
          [[ev.bbox_south, ev.bbox_west], [ev.bbox_north, ev.bbox_east]],
          {
            color: "#f59e0b",
            fillColor: "#f59e0b",
            fillOpacity: 0.1,
            weight: 1.5,
            dashArray: "4 4",
          },
        );

        const time = new Date(ev.timestamp_ms).toLocaleString();
        rect.bindTooltip(() =>
          `<div style="font-weight:600;color:#f59e0b">${ev.title}</div><div>${time}</div><div style="color:#94a3b8;margin-top:2px;font-style:italic">Event Area</div>`
        );

        rect.addTo(map);
        layers.push(rect);
      }
    }

    return () => {
      for (const l of layers) l.remove();
    };
  }, [map, events, theme]);

  return null;
}

/** Interactive map picker for point (single click) or area (two-click corners) selection. */
function MapPickerLayer({ mode, onComplete, onCancel }: {
  mode: "point" | "area";
  onComplete: (result: MapPickResult) => void;
  onCancel: () => void;
}) {
  const map = useMap();
  const firstCorner = useRef<L.LatLng | null>(null);
  const rubberBand = useRef<L.Rectangle | null>(null);

  // Set crosshair cursor on mount, restore on unmount
  useEffect(() => {
    const container = map.getContainer();
    const prev = container.style.cursor;
    container.style.cursor = "crosshair";
    return () => { container.style.cursor = prev; };
  }, [map]);

  // Escape key cancels picking
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  // Clean up rubber-band rectangle on unmount
  useEffect(() => {
    return () => {
      if (rubberBand.current) {
        rubberBand.current.remove();
        rubberBand.current = null;
      }
    };
  }, []);

  useMapEvents({
    click: (e) => {
      // Prevent the click from reaching MapClickHandler (deselect)
      L.DomEvent.stop(e.originalEvent);

      if (mode === "point") {
        onComplete({ type: "point", lat: e.latlng.lat, lng: e.latlng.lng });
        return;
      }

      // Area mode: two-click
      if (!firstCorner.current) {
        firstCorner.current = e.latlng;
        return;
      }

      // Second click — complete the area
      const box = cornersToBox(
        firstCorner.current.lat, firstCorner.current.lng,
        e.latlng.lat, e.latlng.lng,
      );
      if (rubberBand.current) {
        rubberBand.current.remove();
        rubberBand.current = null;
      }
      firstCorner.current = null;
      onComplete({ type: "area", ...box });
    },
    mousemove: (e) => {
      // Rubber-band rectangle for area mode after first click
      if (mode !== "area" || !firstCorner.current) return;
      const bounds: L.LatLngBoundsExpression = [
        [firstCorner.current.lat, firstCorner.current.lng],
        [e.latlng.lat, e.latlng.lng],
      ];
      if (rubberBand.current) {
        rubberBand.current.setBounds(bounds);
      } else {
        rubberBand.current = L.rectangle(bounds, {
          color: "#f59e0b",
          fillColor: "#f59e0b",
          fillOpacity: 0.15,
          weight: 2,
          dashArray: "6 4",
        }).addTo(map);
      }
    },
  });

  return null;
}

/** Debounce for the LRU pass after new tiles are stored: one scan per burst, not per tile. */
const EVICT_DEBOUNCE_MS = 5000;

/**
 * The basemap, loaded through the IndexedDB tile cache (`lib/tile-cache/`).
 *
 * Imperative, like `DeckDotsOverlay`: the layer is built once per tile source and
 * reads the cache settings through a ref on every tile, so changing the radius
 * or the cap never reloads the visible map. Changing the footprint or the cap
 * prunes the store straight away -- including on mount, which covers a
 * receiver that moved while the app was closed.
 */
function CachedBasemap({ tile, origin }: { tile: TileConfig; origin?: ReceiverPoint }) {
  const map = useMap();
  const [{ enabled, radiusNm, maxSizeMb }] = useTileCacheSettings();
  const lat = origin?.lat;
  const lon = origin?.lng;
  const maxBytes = maxSizeMb * 1024 * 1024;
  const ctxRef = useRef<CacheContext | null>(null);
  const evictTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const store = sharedTileStore();
    const footprint = lat != null && lon != null ? { lat, lon, radiusNm } : null;
    ctxRef.current = {
      store,
      enabled,
      footprint,
      onStoreError: recordStoreFailure,
      onStored: () => {
        if (evictTimer.current) return;
        evictTimer.current = setTimeout(() => {
          evictTimer.current = null;
          void store.then((s) => s?.evictTo(maxBytes)).catch(() => {});
        }, EVICT_DEBOUNCE_MS);
      },
    };
    void store
      .then(async (s) => {
        if (!s) return;
        if (footprint) await s.pruneOutside(footprint.lat, footprint.lon, footprint.radiusNm);
        await s.evictTo(maxBytes);
      })
      .catch(() => {});
  }, [enabled, radiusNm, maxBytes, lat, lon]);

  useEffect(
    () => () => {
      if (evictTimer.current) clearTimeout(evictTimer.current);
    },
    [],
  );

  useEffect(() => {
    const layer = createCachedTileLayer(
      tile,
      () => ctxRef.current ?? { store: sharedTileStore(), enabled: false, footprint: null },
    );
    layer.addTo(map);
    layer.bringToBack();
    return () => {
      layer.remove();
    };
  }, [map, tile]);

  return null;
}

/** Adds a credit line to the map's attribution control while mounted. */
function MapAttribution({ text }: { text: string }) {
  const map = useMap();
  useEffect(() => {
    // Attribution on the control, not the tile layer: a tile layer's
    // attribution is fixed at creation, so changing it would reload the tiles.
    const control = map.attributionControl;
    if (!control) return;
    control.addAttribution(text);
    return () => {
      control.removeAttribution(text);
    };
  }, [map, text]);
  return null;
}

const BARB_SIZE = 32;

/** Wind barbs at every grid point of a weather snapshot, for one level. */
function WeatherBarbsLayer({
  snapshot,
  level,
  theme,
}: {
  snapshot: WeatherSnapshot;
  level: WeatherLevel;
  theme: MapTheme;
}) {
  const color = theme === "dark" ? "#e2e8f0" : "#1e293b";

  // Icons are rebuilt only when the snapshot, level or theme changes. The map
  // re-renders about twice a second with live traffic, and a fresh divIcon
  // object makes react-leaflet call setIcon on every one of ~190 markers.
  const barbs = useMemo(() => {
    const fields = fieldsAt(snapshot, level);
    if (!fields) return [];
    return gridPoints(snapshot).flatMap(({ lat, lon, index }) => {
      const wind = windAtPoint(fields, index);
      if (!wind) return [];
      return [
        {
          key: `wx-${index}`,
          position: [lat, lon] as [number, number],
          wind,
          mslp: snapshot.surface.mslp_hpa[index],
          icon: L.divIcon({
            html: windBarbSvg(wind, color, BARB_SIZE),
            className: "",
            iconSize: [BARB_SIZE, BARB_SIZE],
            iconAnchor: [BARB_SIZE / 2, BARB_SIZE / 2],
          }),
        },
      ];
    });
  }, [snapshot, level, color]);

  return (
    <>
      {barbs.map((barb) => (
        <Marker key={barb.key} position={barb.position} icon={barb.icon} keyboard={false}>
          <Tooltip direction="top" offset={[0, -BARB_SIZE / 2]}>
            <div style={{ fontSize: 11 }}>
              <div style={{ fontWeight: 600, color: "#fff" }}>{levelLabel(level)}</div>
              <div>
                Wind: <span style={{ color: "#fff" }}>{formatWind(barb.wind)}</span>
              </div>
              <div>
                MSL pressure:{" "}
                <span style={{ color: "#fff" }}>
                  {barb.mslp != null ? `${barb.mslp.toFixed(1)} hPa` : "N/A"}
                </span>
              </div>
            </div>
          </Tooltip>
        </Marker>
      ))}
    </>
  );
}

/** Leaflet pane for the particle canvas: above tiles and density (400), below every marker (600). */
const PARTICLE_PANE = "weatherParticles";
/** Screen speed, pixels a second per knot: 100 kt crosses 60 px a second at any zoom. */
const PARTICLE_PX_PER_KT_S = 0.6;
/** Opacity each frame keeps of the one before: sets the trail length. */
const PARTICLE_TRAIL_KEEP = 0.92;
/** Bucket value for a particle that respawned this frame: nothing to draw. */
const NO_SEGMENT = 255;

/**
 * Particles drifting with the wind on one level, drawn on a canvas.
 *
 * Imperative, like DeckDotsOverlay: a frame loop has no business in React state.
 * The canvas is cleared while the map pans or zooms and re-seeded when it
 * stops -- particle positions are geographic, but the trails on the canvas
 * are pixels and would smear across a moving map.
 */
function WindParticlesLayer({
  snapshot,
  level,
  theme,
}: {
  snapshot: WeatherSnapshot;
  level: WeatherLevel;
  theme: MapTheme;
}) {
  const map = useMap();

  useEffect(() => {
    const field = createWindField(snapshot, level);
    if (!field) return;
    const gridBounds = fieldBounds(field.grid);
    const colors = PARTICLE_COLORS[theme];

    const pane = map.getPane(PARTICLE_PANE) ?? map.createPane(PARTICLE_PANE);
    pane.style.zIndex = "450";
    pane.style.pointerEvents = "none";
    const canvas = L.DomUtil.create("canvas", "", pane);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      canvas.remove();
      return;
    }

    let particles: Particles | null = null;
    let bounds: GeoBounds | null = null;
    // Screen positions: where each particle is now, and where it was a frame ago.
    let toX = new Float32Array(0);
    let toY = new Float32Array(0);
    let fromX = new Float32Array(0);
    let fromY = new Float32Array(0);
    let bucket = new Uint8Array(0);
    let width = 0;
    let height = 0;
    let zoom = 0;
    let degPerPx = 0;
    let originX = 0;
    let originY = 0;
    let frame = 0;
    let lastMs = 0;
    const px = [0, 0];

    const tick = (nowMs: number) => {
      const p = particles;
      if (!p || !bounds) return;
      const dtS = lastMs ? (nowMs - lastMs) / 1000 : 0;
      lastMs = nowMs;
      stepParticles(p, field, bounds, { dtS, pxPerKtS: PARTICLE_PX_PER_KT_S, degPerPx });

      for (let i = 0; i < p.count; i++) {
        projectMercator(p.lat[i], p.lon[i], zoom, px);
        fromX[i] = toX[i];
        fromY[i] = toY[i];
        toX[i] = px[0] - originX;
        toY[i] = px[1] - originY;
        bucket[i] = p.reborn[i] ? NO_SEGMENT : speedBucket(p.speedKt[i]);
      }

      // Fade what is already drawn, then add this frame's segments on top.
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = `rgba(0, 0, 0, ${PARTICLE_TRAIL_KEEP})`;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = 1.25;
      // One path per colour: a stroke per particle would be thousands of draw calls.
      for (let b = 0; b < colors.length; b++) {
        ctx.beginPath();
        for (let i = 0; i < p.count; i++) {
          if (bucket[i] !== b) continue;
          ctx.moveTo(fromX[i], fromY[i]);
          ctx.lineTo(toX[i], toY[i]);
        }
        ctx.strokeStyle = colors[b];
        ctx.stroke();
      }

      frame = requestAnimationFrame(tick);
    };

    const stop = () => {
      cancelAnimationFrame(frame);
      particles = null;
      ctx.clearRect(0, 0, width, height);
    };

    const reset = () => {
      stop();
      const size = map.getSize();
      width = size.x;
      height = size.y;
      const dpr = window.devicePixelRatio || 1;
      // Resizing a canvas clears it and resets its transform.
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // The pane moves with the map while panning; pin the canvas to the viewport.
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));

      const view = map.getBounds();
      bounds = intersectBounds(gridBounds, {
        south: view.getSouth(),
        west: view.getWest(),
        north: view.getNorth(),
        east: view.getEast(),
      });
      if (!bounds) return;

      zoom = map.getZoom();
      degPerPx = degreesPerPixel(zoom);
      const origin = map.getPixelBounds().min!;
      originX = origin.x;
      originY = origin.y;

      // Size the population to the part of the screen the grid covers, so a
      // zoomed-out view does not pack every particle into a small square.
      projectMercator(bounds.north, bounds.west, zoom, px);
      const [left, top] = px;
      projectMercator(bounds.south, bounds.east, zoom, px);
      const count = particleCount(Math.min(px[0] - left, width), Math.min(px[1] - top, height));

      const p = createParticles(count, bounds);
      toX = new Float32Array(count);
      toY = new Float32Array(count);
      fromX = new Float32Array(count);
      fromY = new Float32Array(count);
      bucket = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        projectMercator(p.lat[i], p.lon[i], zoom, px);
        toX[i] = px[0] - originX;
        toY[i] = px[1] - originY;
      }
      particles = p;
      lastMs = 0;
      frame = requestAnimationFrame(tick);
    };

    map.on("movestart zoomstart", stop);
    map.on("moveend resize", reset);
    reset();

    return () => {
      map.off("movestart zoomstart", stop);
      map.off("moveend resize", reset);
      cancelAnimationFrame(frame);
      canvas.remove();
    };
  }, [map, snapshot, level, theme]);

  return null;
}

interface Props {
  tracks: AircraftTrack[];
  historyTracks: AircraftTrack[];
  dbHistoryTracks?: AircraftTrack[];
  importedTracks?: AircraftTrack[];
  mapTheme: "light" | "dark";
  onToggleTheme: () => void;
  trajectoryStyle: "line" | "dots";
  /** Draw the trail of past positions behind live aircraft. Defaults to true. */
  showPositions?: boolean;
  /** Draw `HEX/CALLSIGN` labels beside live aircraft. Defaults to false. */
  showLabels?: boolean;
  /** Receiver for range lines — deliberately NOT gated by "Show receiver". */
  rangeLineOrigin?: ReceiverPoint;
  /** Centre of the tile cache footprint — like `rangeLineOrigin`, NOT gated by "Show receiver". */
  tileCacheOrigin?: ReceiverPoint;
  /** Selected aircraft with a position; one range line each while the mode is on. */
  rangeLineTargets?: AircraftTrack[];
  showRangeLines?: boolean;
  onToggleRangeLines?: () => void;
  showDensity: boolean;
  densityMetric: DensityMetric;
  densityTracks: AircraftTrack[];
  densityAltitudeMin: number;
  densityAltitudeMax: number;
  densityTooltipMode: DensityTooltipMode;
  liveColorMode: AltitudeColorMode;
  historyColorMode: AltitudeColorMode;
  selectedHexIdents: Set<string>;
  onSelectTrack: (hex: string | null) => void;
  receiverLocation?: { lat: number; lng: number; alt: number | null };
  /** Planned routes of agent-generated trajectories currently on the map. */
  simulatedRoutes?: AgentTrajectory[];
  eventsOfInterest?: EventOfInterest[];
  onContextMenu?: (lat: number, lng: number, x: number, y: number) => void;
  mapPickingMode?: "point" | "area" | null;
  onMapPickComplete?: (result: MapPickResult) => void;
  onMapPickCancel?: () => void;
  onFlyToReady?: (fn: (lat: number, lng: number, zoom: number) => void) => void;
  /** Weather snapshot to draw, or null to draw none. */
  weather?: WeatherSnapshot | null;
  weatherLevel?: WeatherLevel;
  /** Draw wind barbs at the grid points. */
  weatherBarbs?: boolean;
  /** Draw animated wind particles. */
  weatherParticles?: boolean;
}

/** Renders H3 density hexagons with zoom-adaptive resolution. */
function DensityLayer({
  showDensity,
  densityTracks,
  densityMetric,
  densityAltitudeMin,
  densityAltitudeMax,
  densityTooltipMode,
  receiverLocation,
  theme,
}: {
  showDensity: boolean;
  densityTracks: AircraftTrack[];
  densityMetric: DensityMetric;
  densityAltitudeMin: number;
  densityAltitudeMax: number;
  densityTooltipMode: DensityTooltipMode;
  receiverLocation?: { lat: number; lng: number; alt: number | null };
  theme: MapTheme;
}) {
  const zoom = useMapZoom(300);
  const resolution = zoomToH3Resolution(zoom);

  // Only pass altitude range filter when it's not the full default range
  const altitudeRange = useMemo<DensityAltitudeRange | undefined>(
    () => densityAltitudeMin > 0 || densityAltitudeMax < 50000
      ? { altitudeMin: densityAltitudeMin, altitudeMax: densityAltitudeMax }
      : undefined,
    [densityAltitudeMin, densityAltitudeMax],
  );

  const densityGeoJson = useMemo(
    () => (showDensity ? computeH3Density(densityTracks, densityMetric, resolution, altitudeRange) : null),
    [showDensity, densityTracks, densityMetric, resolution, altitudeRange],
  );

  // react-leaflet's GeoJSON doesn't re-render on data change — use key to force remount
  const densityKey = densityGeoJson
    ? `density-${densityMetric}-${resolution}-${densityGeoJson.features.length}-${densityTracks.length}-${theme}-${densityAltitudeMin}-${densityAltitudeMax}-${densityTooltipMode}`
    : "density-off";

  if (!densityGeoJson || densityGeoJson.features.length === 0) return null;

  return (
    <GeoJSON
      key={densityKey}
      data={densityGeoJson}
      style={(feature) => {
        const props = (feature?.properties ?? { normalized: 0, value: 0 }) as DensityProperties;
        if (densityMetric === "altitude" || densityMetric === "altitude_min" || densityMetric === "altitude_max") {
          const c = altitudeToColor(props.value, theme);
          return { color: c, fillColor: c, fillOpacity: 0.08, weight: 1, opacity: 0.2 };
        }
        const { color, fillOpacity } = densityColor(props.normalized, theme);
        return { color, fillColor: color, fillOpacity, weight: 1, opacity: 0.4 };
      }}
      onEachFeature={(feature, layer) => {
        const props = feature.properties as DensityProperties;
        const text = buildDensityTooltip(densityTooltipMode, props, densityMetric, receiverLocation);
        if (text !== null) layer.bindTooltip(text, { sticky: true });
      }}
    />
  );
}

/**
 * Cached [lat, lng] extraction from positions.
 * Supports both tuple arrays (live tracks) and ColumnarPositions (batch tracks).
 * WeakMap keyed on positions reference — static tracks have stable refs, so cache hits.
 */
const latLngCache = new WeakMap<object, [number, number][]>();
function toLatLngs(positions: Positions): [number, number][] {
  const existing = latLngCache.get(positions);
  if (existing) return existing;

  let result: [number, number][];
  if (isColumnar(positions)) {
    result = new Array(positions.length);
    for (let i = 0; i < positions.length; i++) {
      result[i] = [positions.lat[i], positions.lng[i]];
    }
  } else {
    result = positions.map(p => [p[0], p[1]]);
  }
  latLngCache.set(positions, result);
  return result;
}

const LABEL_PANE = "trackLabels";

/**
 * Receiver → aircraft range lines: a dashed great-circle polyline in receiver
 * magenta plus a distance/bearing/elevation chip at its midpoint. Declarative —
 * there are only ever as many as there are selected aircraft. Nothing here is
 * interactive, so a line or chip never takes a click meant for an aircraft.
 */
function RangeLinesLayer({
  origin,
  targets,
  theme,
}: {
  origin: ReceiverPoint;
  targets: AircraftTrack[];
  theme: MapTheme;
}) {
  const dark = theme === "dark";
  return (
    <>
      {targets.map((t) => {
        const label = rangeLineLabel(t, origin);
        if (label === null) return null;
        const points = greatCirclePoints([origin.lat, origin.lng], [t.latitude!, t.longitude!]);
        const mid = midpoint(points);
        const chipStyle = [
          "position:absolute",
          "transform:translate(-50%,-50%)",
          "white-space:nowrap",
          "padding:0 4px",
          "line-height:14px",
          "font-family:ui-monospace,SFMono-Regular,Menlo,monospace",
          "font-size:10px",
          "border-radius:2px",
          `border-left:2px solid ${RANGE_LINE_COLOR}`,
          // Light-handed backdrop: the map stays visible through the chip, and a
          // slight blur keeps the opaque text readable over busy tiles. The
          // -webkit- prefix is for older WKWebView (Tauri on macOS).
          dark ? "background:rgba(15,23,42,0.45);color:#f9a8d4" : "background:rgba(255,255,255,0.5);color:#0f172a",
          "backdrop-filter:blur(2px)",
          "-webkit-backdrop-filter:blur(2px)",
        ].join(";");
        return (
          <div key={trackKey(t)}>
            <Polyline
              positions={points}
              interactive={false}
              pathOptions={{ color: RANGE_LINE_COLOR, weight: 1.5, opacity: 0.9, dashArray: "6 4" }}
            />
            <Marker
              position={mid}
              interactive={false}
              keyboard={false}
              icon={L.divIcon({
                html: `<div style="${chipStyle}">${label}</div>`,
                className: "range-line-label",
                iconSize: [0, 0],
                iconAnchor: [0, 0],
              })}
            />
          </div>
        );
      })}
    </>
  );
}

/**
 * `HEX/CALLSIGN` labels beside live aircraft, placed by `layoutLabels`.
 *
 * Imperative like `DeckDotsOverlay`: one zero-size, non-interactive marker per label in
 * its own pane (above aircraft icons, `pointer-events: none` so a label never
 * steals a click). Re-laid out on every feed update and on zoom/move/resize,
 * feeding the previous result back so labels keep their slot; an icon is only
 * rebuilt when its slot, text, colour or selection changes.
 */
function TrackLabelsLayer({
  tracks,
  selectedHexIdents,
  theme,
}: {
  tracks: AircraftTrack[];
  selectedHexIdents: Set<string>;
  theme: MapTheme;
}) {
  const map = useMap();
  const markers = useRef<Map<string, { marker: L.Marker; sig: string }>>(new Map());
  const previous = useRef<Map<string, LabelPlacement | null>>(new Map());
  const [viewTick, setViewTick] = useState(0);
  useMapEvents({
    zoomend: () => setViewTick((n) => n + 1),
    moveend: () => setViewTick((n) => n + 1),
    resize: () => setViewTick((n) => n + 1),
  });

  useEffect(() => {
    const pane = map.getPane(LABEL_PANE) ?? map.createPane(LABEL_PANE);
    pane.style.zIndex = "640";
    pane.style.pointerEvents = "none";
    const live = markers.current;
    return () => {
      for (const { marker } of live.values()) marker.remove();
      live.clear();
      previous.current = new Map();
    };
  }, [map]);

  useEffect(() => {
    const size = map.getSize();
    const items: LabelItem[] = [];
    const byKey = new Map<string, AircraftTrack>();
    for (const t of tracks) {
      if (t.latitude === null || t.longitude === null) continue;
      const key = trackKey(t);
      const pt = map.latLngToContainerPoint([t.latitude, t.longitude]);
      byKey.set(key, t);
      items.push({
        key,
        x: pt.x,
        y: pt.y,
        heading: t.track,
        text: formatTrackLabel(t),
        selected: selectedHexIdents.has(key),
        priority: t.last_seen,
      });
    }

    const layout = layoutLabels(items, { width: size.x, height: size.y }, previous.current);
    previous.current = layout;

    const live = markers.current;
    for (const item of items) {
      const p = layout.get(item.key);
      const existing = live.get(item.key);
      if (!p) {
        if (existing) {
          existing.marker.remove();
          live.delete(item.key);
        }
        continue;
      }
      const t = byKey.get(item.key)!;
      const latLng: L.LatLngExpression = [t.latitude!, t.longitude!];
      const color = cachedAltitudeToColor(t.altitude, theme);
      const sig = `${p.candidate}|${item.text}|${item.selected}|${color}|${theme}`;
      if (existing) {
        existing.marker.setLatLng(latLng);
        if (existing.sig !== sig) {
          existing.marker.setIcon(labelIcon(p, item.text, color, item.selected, theme));
          existing.sig = sig;
        }
      } else {
        const marker = L.marker(latLng, {
          icon: labelIcon(p, item.text, color, item.selected, theme),
          pane: LABEL_PANE,
          interactive: false,
          keyboard: false,
        }).addTo(map);
        live.set(item.key, { marker, sig });
      }
    }
    // Aircraft that left the feed (or the live set) take their label with them.
    for (const [key, { marker }] of live) {
      if (!layout.get(key)) {
        marker.remove();
        live.delete(key);
      }
    }
  }, [map, tracks, selectedHexIdents, theme, viewTick]);

  return null;
}

function labelIcon(p: LabelPlacement, text: string, color: string, selected: boolean, theme: MapTheme): L.DivIcon {
  return L.divIcon({
    html: trackLabelHtml(p, text, color, selected, theme),
    className: "track-label",
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

export function MapInner({ tracks, historyTracks, dbHistoryTracks = [], importedTracks = [], mapTheme, onToggleTheme, trajectoryStyle, showPositions = true, showLabels = false, rangeLineOrigin, tileCacheOrigin, rangeLineTargets = [], showRangeLines = false, onToggleRangeLines, showDensity, densityMetric, densityTracks, densityAltitudeMin, densityAltitudeMax, densityTooltipMode, liveColorMode, historyColorMode, selectedHexIdents, onSelectTrack, receiverLocation, simulatedRoutes, eventsOfInterest = [], onContextMenu, mapPickingMode, onMapPickComplete, onMapPickCancel, onFlyToReady, weather = null, weatherLevel = 250, weatherBarbs = true, weatherParticles = false }: Props) {
  // Memoised: the basemap layer is rebuilt (and every tile reloaded) when this changes.
  const tile = useMemo(() => tileConfig(mapTheme, CARTO_API_KEY), [mapTheme]);
  const mapCenter: [number, number] = receiverLocation
    ? [receiverLocation.lat, receiverLocation.lng]
    : DEFAULT_CENTER;

  // Reorder tracks so selected renders on top (last in array = top layer)
  const orderedTracks = useMemo(
    () => orderTracksWithSelectedLast(tracks, selectedHexIdents),
    [tracks, selectedHexIdents],
  );
  const orderedHistory = useMemo(
    () => orderTracksWithSelectedLast(historyTracks, selectedHexIdents),
    [historyTracks, selectedHexIdents],
  );

  // Drawn bottom to top, as the DotsLayers were mounted.
  const dotSets = useMemo<DotSet[]>(() => {
    if (trajectoryStyle !== "dots") return [];
    const sets: DotSet[] = [
      { type: "history", tracks: historyTracks, colorMode: historyColorMode },
      { type: "dbHistory", tracks: dbHistoryTracks, colorMode: "plot" },
      { type: "imported", tracks: importedTracks, colorMode: "plot" },
      { type: "live", tracks: showPositions ? tracks : [], colorMode: liveColorMode },
    ];
    return sets.filter((s) => s.tracks.length > 0);
  }, [trajectoryStyle, historyTracks, historyColorMode, dbHistoryTracks, importedTracks, showPositions, tracks, liveColorMode]);

  const handleDeselect = useCallback(() => onSelectTrack(null), [onSelectTrack]);

  // Capture the map's flyTo callback locally (also forwarded to copilot via onFlyToReady)
  // so the "center on antenna" button can navigate the map from outside MapContainer.
  const flyToRef = useRef<((lat: number, lng: number, zoom: number) => void) | null>(null);
  const handleFlyToReady = useCallback(
    (fn: (lat: number, lng: number, zoom: number) => void) => {
      flyToRef.current = fn;
      onFlyToReady?.(fn);
    },
    [onFlyToReady],
  );
  const handleCenterOnAntenna = useCallback(() => {
    if (receiverLocation) {
      flyToRef.current?.(receiverLocation.lat, receiverLocation.lng, DEFAULT_ZOOM);
    }
  }, [receiverLocation]);

  return (
    <div className="h-full w-full relative">
      <MapContainer
        center={mapCenter}
        zoom={DEFAULT_ZOOM}
        className="h-full w-full"
        zoomControl={true}
        preferCanvas={true}
      >
        <MapResizeHandler />
        <MapClickHandler onDeselect={handleDeselect} />
        <FlyToHandler onReady={handleFlyToReady} />
        <CachedBasemap tile={tile} origin={tileCacheOrigin} />

        {/* Density hexagons — zoom-adaptive H3 resolution */}
        <DensityLayer showDensity={showDensity} densityTracks={densityTracks} densityMetric={densityMetric} densityAltitudeMin={densityAltitudeMin} densityAltitudeMax={densityAltitudeMax} densityTooltipMode={densityTooltipMode} receiverLocation={receiverLocation} theme={mapTheme} />

        {/* Weather — added before the traffic so aircraft draw on top. The credit is
            required whenever the data is shown, so it follows either display. */}
        {weather && (weatherBarbs || weatherParticles) && <MapAttribution text={weather.attribution} />}
        {weather && weatherParticles && <WindParticlesLayer snapshot={weather} level={weatherLevel} theme={mapTheme} />}
        {weather && weatherBarbs && <WeatherBarbsLayer snapshot={weather} level={weatherLevel} theme={mapTheme} />}

        {/* History tracks — rendered first so active tracks layer on top */}
        {/* Every dot set (history, DB History, imported, live) on the GPU, in its own pane */}
        {dotSets.length > 0 && <DeckDotsOverlay sets={dotSets} selected={selectedHexIdents} theme={mapTheme} />}
        {trajectoryStyle === "line" && orderedHistory.map((t) => {
          if (t.positions.length < 2) return null;
          const trackColor = cachedAltitudeToColor(t.altitude, mapTheme);
          const isSelected = selectedHexIdents.has(trackKey(t));

          return (
            <Polyline
              key={`hist-${trackKey(t)}`}
              positions={toLatLngs(t.positions)}
              pathOptions={{
                color: trackColor,
                weight: isSelected ? 3 : 1,
                opacity: isSelected ? 0.7 : 0.25,
              }}
            >
              <Tooltip sticky>
                <div style={{ fontSize: 11 }}>
                  <div style={{ fontWeight: 600, color: "#fff" }}>
                    {t.callsign ?? t.hex_ident}
                  </div>
                  <div>Hex: {t.hex_ident}</div>
                  <div>Alt: <span style={{ color: "#fff" }}>{formatAlt(t.altitude)}</span></div>
                  <div>Last seen: {timeAgo(t.last_seen)}</div>
                </div>
              </Tooltip>
            </Polyline>
          );
        })}

        {/* DB History tracks — cyan polylines/dots */}
        {trajectoryStyle === "line" && dbHistoryTracks.map((t) => {
          if (t.positions.length < 2) return null;
          const isSelected = selectedHexIdents.has(trackKey(t));
          return (
            <Polyline
              key={`dbhist-${trackKey(t)}`}
              positions={toLatLngs(t.positions)}
              pathOptions={{
                color: "#06b6d4",
                weight: isSelected ? 3 : 2,
                opacity: isSelected ? 0.8 : 0.5,
              }}
              eventHandlers={{ click: () => onSelectTrack(trackKey(t)) }}
            >
              <Tooltip sticky>
                <div style={{ fontSize: 11 }}>
                  <div style={{ fontWeight: 600, color: "#fff" }}>
                    {t.callsign ?? t.hex_ident}
                  </div>
                  <div>Hex: {t.hex_ident}</div>
                  <div>Alt: <span style={{ color: "#fff" }}>{formatAlt(t.altitude)}</span></div>
                  <div style={{ color: "#22d3ee", marginTop: 2 }}>DB History</div>
                </div>
              </Tooltip>
            </Polyline>
          );
        })}

        {/* Imported tracks — dots or dashed indigo polylines */}
        {trajectoryStyle === "line" && importedTracks.map((t) => {
          if (t.positions.length < 2) return null;
          const isSelected = selectedHexIdents.has(trackKey(t));
          return (
            <Polyline
              key={`imported-${trackKey(t)}`}
              positions={toLatLngs(t.positions)}
              pathOptions={{
                color: "#818cf8",
                weight: isSelected ? 3 : 2,
                opacity: isSelected ? 0.8 : 0.5,
                dashArray: isSelected ? undefined : "6 4",
              }}
              eventHandlers={{ click: () => onSelectTrack(trackKey(t)) }}
            >
              <Tooltip sticky>
                <div style={{ fontSize: 11 }}>
                  <div style={{ fontWeight: 600, color: "#fff" }}>
                    {t.callsign ?? t.hex_ident}
                  </div>
                  <div>Hex: {t.hex_ident}</div>
                  <div>Alt: <span style={{ color: "#fff" }}>{formatAlt(t.altitude)}</span></div>
                  <div style={{ color: "#818cf8", marginTop: 2 }}>Imported</div>
                </div>
              </Tooltip>
            </Polyline>
          );
        })}

        {/* Active track dots — imperative layer for performance */}

        {/* Planned routes of agent-generated trajectories.
            Dashed and dimmed so they read as *intent* rather than as flown
            history — the solid trail behind the aircraft is the flown part. */}
        {simulatedRoutes?.map((route) => {
          const legs = routeLegs(route);
          const total = legs.length;
          return legs.map((leg) => {
            if (leg.positions.length < 2) return null;
            return (
              <Polyline
                key={`sim-route-${route.hex_ident}-${leg.legIndex}`}
                positions={leg.positions}
                pathOptions={{
                  color: SIM_LEG_COLORS[leg.legIndex % SIM_LEG_COLORS.length],
                  weight: 1.5,
                  opacity: 0.45,
                  dashArray: "4 6",
                }}
              >
                <Tooltip sticky>
                  <div style={{ fontSize: 11 }}>
                    <div style={{ fontWeight: 600, color: "#38bdf8" }}>
                      {route.callsign || route.hex_ident}
                    </div>
                    <div>Simulated route ({route.category})</div>
                    {total > 1 && (
                      <div>
                        Leg {leg.legIndex + 1} of {total}
                      </div>
                    )}
                    <div>{route.waypoints.length} waypoints</div>
                  </div>
                </Tooltip>
              </Polyline>
            );
          });
        })}

        {/* Receiver location marker */}
        {receiverLocation && (
          <Marker
            position={[receiverLocation.lat, receiverLocation.lng]}
            icon={L.divIcon({
              html: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e91e90" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><line x1="5" y1="5" x2="12" y2="10"/><line x1="19" y1="5" x2="12" y2="10"/><line x1="8" y1="3" x2="12" y2="7"/><line x1="16" y1="3" x2="12" y2="7"/></svg>`,
              className: "",
              iconSize: [16, 16],
              iconAnchor: [8, 16],
            })}
          >
            <Tooltip direction="top" offset={[0, -10]}>
              <div style={{ fontSize: 11 }}>
                <div style={{ fontWeight: 600, color: "#e91e90" }}>Receiver</div>
                {receiverLocation.alt != null && <div>Alt: <span style={{ color: "#fff" }}>{receiverLocation.alt.toLocaleString()} ft</span></div>}
              </div>
            </Tooltip>
          </Marker>
        )}

        {/* Context menu handler (disabled during picking) */}
        {onContextMenu && !mapPickingMode && <ContextMenuHandler onContextMenu={onContextMenu} />}

        {/* Map location picker (point click or area two-click) */}
        {mapPickingMode && onMapPickComplete && onMapPickCancel && (
          <MapPickerLayer mode={mapPickingMode} onComplete={onMapPickComplete} onCancel={onMapPickCancel} />
        )}

        {/* Events of interest markers */}
        {eventsOfInterest.length > 0 && <EventMarkersLayer events={eventsOfInterest} theme={mapTheme} />}

        {/* Range lines: receiver → every selected aircraft */}
        {showRangeLines && rangeLineOrigin && rangeLineTargets.length > 0 && (
          <RangeLinesLayer origin={rangeLineOrigin} targets={rangeLineTargets} theme={mapTheme} />
        )}

        {/* Live track labels — auto-placed, live mode only (tracks is empty otherwise) */}
        {showLabels && tracks.length > 0 && (
          <TrackLabelsLayer tracks={tracks} selectedHexIdents={selectedHexIdents} theme={mapTheme} />
        )}

        {/* Active tracks — aircraft markers and line trajectories */}
        {orderedTracks.map((t) => {
          if (t.latitude === null || t.longitude === null) return null;
          const trackColor = cachedAltitudeToColor(t.altitude, mapTheme);
          const isSelected = selectedHexIdents.has(trackKey(t));
          const icon = aircraftIcon(t.track ?? 0, trackColor, isSelected);

          return (
            <div key={trackKey(t)}>
              <Marker
                position={[t.latitude, t.longitude]}
                icon={icon}
                eventHandlers={{ click: () => onSelectTrack(trackKey(t)) }}
              >
                <Tooltip direction="top" offset={[0, -12]}>
                  <div style={{ fontSize: 11 }}>
                    <div style={{ fontWeight: 600, color: "#22d3ee" }}>
                      {t.callsign ?? t.hex_ident}
                    </div>
                    <div>Hex: {t.hex_ident}</div>
                    {t.altitude !== null && (
                      <div>Alt: <span style={{ color: "#fff" }}>{t.altitude.toLocaleString()} ft</span></div>
                    )}
                    {t.ground_speed !== null && (
                      <div>Spd: <span style={{ color: "#fff" }}>{t.ground_speed.toFixed(0)} kts</span></div>
                    )}
                    {t.squawk !== null && <div>Sqk: <span style={{ color: "#fff" }}>{t.squawk}</span></div>}
                  </div>
                </Tooltip>
              </Marker>

              {/* Line trajectory */}
              {t.positions.length > 1 && trajectoryStyle === "line" && showPositions && (
                <Polyline
                  positions={toLatLngs(t.positions)}
                  pathOptions={{
                    color: trackColor,
                    weight: isSelected ? 4 : 2,
                    opacity: isSelected ? 0.9 : 0.6,
                  }}
                />
              )}
            </div>
          );
        })}
      </MapContainer>

      <MapTileToggle theme={mapTheme} onToggle={onToggleTheme} />
      <CenterOnAntennaButton onClick={handleCenterOnAntenna} disabled={!receiverLocation} />
      {onToggleRangeLines && (
        <RangeLineButton
          active={showRangeLines}
          onToggle={onToggleRangeLines}
          disabled={!rangeLineOrigin}
          hasTargets={rangeLineTargets.length > 0}
        />
      )}
      <AltitudeLegend theme={mapTheme} />
      {weather && weatherParticles && <WindSpeedLegend theme={mapTheme} />}
    </div>
  );
}

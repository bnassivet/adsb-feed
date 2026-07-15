"use client";
import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, GeoJSON, Tooltip, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { AircraftTrack, DensityMetric, DensityTooltipMode, AltitudeColorMode, EventOfInterest, MapPickResult, Positions } from "@/lib/types";
import { zoomToH3Resolution, trackKey, cornersToBox, isColumnar } from "@/lib/types";
import { altitudeToColor, densityColor, cachedAltitudeToColor, type MapTheme } from "@/lib/colors";
import { computeH3Density } from "@/lib/h3-density";
import type { DensityProperties, DensityAltitudeRange } from "@/lib/h3-density";
import { useMapZoom } from "@/hooks/useMapZoom";
import { aircraftIconHtml } from "@/lib/aircraft-icon";
import { haversineDistanceNm } from "@/lib/geo";
import { orderTracksWithSelectedLast } from "@/lib/track-ordering";
import { subsamplePositions } from "@/lib/subsample";
import { MapTileToggle } from "./MapTileToggle";
import { CenterOnAntennaButton } from "./CenterOnAntennaButton";
import { AltitudeLegend } from "./AltitudeLegend";

// Default center: Montreal
const DEFAULT_CENTER: [number, number] = [45.5, -73.6];
const DEFAULT_ZOOM = 8;

const TILE_CONFIGS = {
  light: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  },
} as const;

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

/** Formats a relative time string from a timestamp. */
function timeAgo(lastSeen: number): string {
  const seconds = Math.floor((Date.now() - lastSeen) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m ago`;
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

interface Props {
  tracks: AircraftTrack[];
  historyTracks: AircraftTrack[];
  dbHistoryTracks?: AircraftTrack[];
  importedTracks?: AircraftTrack[];
  mapTheme: "light" | "dark";
  onToggleTheme: () => void;
  trajectoryStyle: "line" | "dots";
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
  eventsOfInterest?: EventOfInterest[];
  onContextMenu?: (lat: number, lng: number, x: number, y: number) => void;
  mapPickingMode?: "point" | "area" | null;
  onMapPickComplete?: (result: MapPickResult) => void;
  onMapPickCancel?: () => void;
  onFlyToReady?: (fn: (lat: number, lng: number, zoom: number) => void) => void;
}

/** Build compact (single-line) tooltip for density cell. */
function buildCompactTooltip(props: DensityProperties, metric: DensityMetric): string {
  const val = `<span style="color:#fff">${Math.round(props.value).toLocaleString()}</span>`;
  if (metric === "altitude") return `Mean alt: ${val} ft`;
  if (metric === "altitude_min") return `Min alt: ${val} ft`;
  if (metric === "altitude_max") return `Max alt: ${val} ft`;
  const label = metric === "positions" ? "Positions" : "Aircraft";
  return `${label}: ${val}`;
}

/** Build extended (multi-line) tooltip showing all metrics + distance from receiver. */
function buildExtendedTooltip(
  props: DensityProperties,
  receiverLocation?: { lat: number; lng: number; alt: number | null },
): string {
  const w = (v: string) => `<span style="color:#fff">${v}</span>`;
  const fmtAlt = (v: number | null) => v != null ? w(`${Math.round(v).toLocaleString()} ft`) : "N/A";

  const lines: string[] = [
    `<div style="font-weight:600;color:#22d3ee;margin-bottom:2px">H3 Cell</div>`,
    `Positions: ${w(props.positions.toLocaleString())}`,
    `Aircraft: ${w(props.aircraftCount.toLocaleString())}`,
    `Mean alt: ${fmtAlt(props.meanAlt)}`,
    `Min alt: ${fmtAlt(props.minAlt)}`,
    `Max alt: ${fmtAlt(props.maxAlt)}`,
  ];

  if (receiverLocation && props.cellCenter) {
    const d = haversineDistanceNm(
      receiverLocation.lat, receiverLocation.lng,
      props.cellCenter[0], props.cellCenter[1],
    );
    lines.push(`Distance: ${w(`${d.toFixed(1)} NM`)}`);
  }

  return lines.join("<br>");
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
        const text = densityTooltipMode === "extended"
          ? buildExtendedTooltip(props, receiverLocation)
          : buildCompactTooltip(props, densityMetric);
        layer.bindTooltip(text, { sticky: true });
      }}
    />
  );
}

/** Format altitude for tooltip display. */
function formatAlt(alt: number | null | undefined): string {
  if (alt == null) return "N/A"; // handles both null and undefined
  return `${alt.toLocaleString()} ft`;
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

/**
 * Renders dots imperatively via Leaflet API — bypasses React per-dot reconciliation.
 *
 * Split into two effects:
 * 1. Marker creation: runs when tracks/colorMode/type/theme change (heavy — creates all markers)
 * 2. Selection restyle: runs when selectedHexIdents change (light — only updates radius/opacity
 *    on the 2 affected tracks: previously selected + newly selected)
 */
function DotsLayer({
  tracks,
  colorMode,
  type,
  selectedHexIdents,
  theme,
}: {
  tracks: AircraftTrack[];
  colorMode: AltitudeColorMode;
  type: "history" | "live" | "imported" | "dbHistory";
  selectedHexIdents: Set<string>;
  theme: MapTheme;
}) {
  const map = useMap();
  // Per-track marker groups for targeted restyle on selection change
  const markersByTrack = useRef<Map<string, L.CircleMarker[]>>(new Map());
  const prevSelected = useRef<Set<string>>(new Set());
  // Track zoom/bounds for subsampling — triggers re-render on viewport change
  const [viewState, setViewState] = useState({ zoom: map.getZoom(), bounds: map.getBounds() });
  useMapEvents({
    zoomend: () => setViewState({ zoom: map.getZoom(), bounds: map.getBounds() }),
    moveend: () => setViewState({ zoom: map.getZoom(), bounds: map.getBounds() }),
  });

  const baseRadius = type === "history" ? 2 : type === "imported" ? 2.5 : type === "dbHistory" ? 2.5 : 3;
  const baseFillOpacity = type === "history" ? 0.2 : type === "imported" ? 0.35 : type === "dbHistory" ? 0.4 : 0.6;

  // Effect 1: Create/destroy markers when tracks or visual config change
  useEffect(() => {
    const groupMap = markersByTrack.current;
    // Clear previous markers
    for (const markers of groupMap.values()) {
      for (const m of markers) m.remove();
    }
    groupMap.clear();

    const mapBounds = {
      north: viewState.bounds.getNorth(),
      south: viewState.bounds.getSouth(),
      east: viewState.bounds.getEast(),
      west: viewState.bounds.getWest(),
    };

    for (const t of tracks) {
      if (t.positions.length < 2) continue;
      const key = trackKey(t);
      const trackColor = cachedAltitudeToColor(t.altitude, theme);
      const isSelected = selectedHexIdents.has(key);
      const radius = isSelected ? baseRadius + 2 : baseRadius;
      const fillOpacity = isSelected ? 0.9 : baseFillOpacity;
      const trackMarkers: L.CircleMarker[] = [];

      // Extract position accessors — columnar (Float64Array) or tuple ([lat,lng,alt][])
      const positions = t.positions;
      const columnar = isColumnar(positions);
      const pLat = columnar ? positions.lat : null;
      const pLng = columnar ? positions.lng : null;
      const pAlt = columnar ? positions.alt : null;

      // Subsample: skip positions that map to the same pixel at current zoom
      // Selected tracks render at full detail for inspection
      const indices = isSelected
        ? null  // full detail
        : subsamplePositions(positions, viewState.zoom, mapBounds);

      const count = indices ? indices.length : positions.length;

      for (let idx = 0; idx < count; idx++) {
        const i = indices ? indices[idx] : idx;
        let lat: number, lng: number, alt: number | null;
        if (columnar) {
          lat = pLat![i]; lng = pLng![i];
          const a = pAlt![i]; alt = Number.isNaN(a) ? null : a;
        } else {
          const p = (positions as [number, number, number | null][])[i];
          lat = p[0]; lng = p[1]; alt = p[2];
        }
        const dotColor = colorMode === "plot" ? cachedAltitudeToColor(alt, theme) : trackColor;
        const isLast = i === t.positions.length - 1;

        const marker = L.circleMarker([lat, lng], {
          radius,
          color: dotColor,
          fillColor: dotColor,
          fillOpacity,
          weight: 0,
        });

        // Lazy tooltip — content built only on hover
        const label = t.callsign ?? t.hex_ident;
        if (type === "history") {
          marker.bindTooltip(() => {
            const parts = [
              `<div style="font-weight:600;color:#fff">${label}</div>`,
              `<div>Hex: ${t.hex_ident}</div>`,
              `<div>Alt: <span style="color:#fff">${formatAlt(alt)}</span></div>`,
            ];
            if (isLast) parts.push(`<div>Last seen: ${timeAgo(t.last_seen)}</div>`);
            return parts.join("");
          });
        } else if (type === "dbHistory") {
          marker.bindTooltip(() =>
            `<div style="font-weight:600;color:#fff">${label}</div><div>Hex: ${t.hex_ident}</div><div>Alt: <span style="color:#fff">${formatAlt(alt)}</span></div><div style="color:#22d3ee;margin-top:2px">DB History</div>`
          );
        } else if (type === "imported") {
          marker.bindTooltip(() =>
            `<div style="font-weight:600;color:#fff">${label}</div><div>Hex: ${t.hex_ident}</div><div>Alt: <span style="color:#fff">${formatAlt(alt)}</span></div><div style="color:#818cf8;margin-top:2px">Imported</div>`
          );
        } else {
          marker.bindTooltip(() =>
            `<div style="font-weight:600;color:#fff">${label}</div><div>Alt: <span style="color:#fff">${formatAlt(alt)}</span></div>`
          );
        }

        marker.addTo(map);
        trackMarkers.push(marker);
      }
      groupMap.set(key, trackMarkers);
    }

    prevSelected.current = new Set(selectedHexIdents);

    return () => {
      for (const markers of groupMap.values()) {
        for (const m of markers) m.remove();
      }
      groupMap.clear();
    };
    // Intentionally excludes selectedHexIdents — handled by Effect 2
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, tracks, colorMode, type, theme, baseRadius, baseFillOpacity, viewState]);

  // Effect 2: Restyle only changed tracks on selection change (no marker recreation)
  useEffect(() => {
    const groupMap = markersByTrack.current;
    if (groupMap.size === 0) return;

    const prev = prevSelected.current;
    // Find tracks that changed selection state
    const changed = new Set<string>();
    for (const key of selectedHexIdents) {
      if (!prev.has(key)) changed.add(key);
    }
    for (const key of prev) {
      if (!selectedHexIdents.has(key)) changed.add(key);
    }

    for (const key of changed) {
      const markers = groupMap.get(key);
      if (!markers) continue;
      const isNowSelected = selectedHexIdents.has(key);
      const radius = isNowSelected ? baseRadius + 2 : baseRadius;
      const fillOpacity = isNowSelected ? 0.9 : baseFillOpacity;
      for (const m of markers) {
        m.setRadius(radius);
        m.setStyle({ fillOpacity });
      }
    }

    prevSelected.current = new Set(selectedHexIdents);
  }, [selectedHexIdents, baseRadius, baseFillOpacity]);

  return null;
}

export function MapInner({ tracks, historyTracks, dbHistoryTracks = [], importedTracks = [], mapTheme, onToggleTheme, trajectoryStyle, showDensity, densityMetric, densityTracks, densityAltitudeMin, densityAltitudeMax, densityTooltipMode, liveColorMode, historyColorMode, selectedHexIdents, onSelectTrack, receiverLocation, eventsOfInterest = [], onContextMenu, mapPickingMode, onMapPickComplete, onMapPickCancel, onFlyToReady }: Props) {
  const tile = TILE_CONFIGS[mapTheme];
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
        <TileLayer
          key={mapTheme}
          attribution={tile.attribution}
          url={tile.url}
        />

        {/* Density hexagons — zoom-adaptive H3 resolution */}
        <DensityLayer showDensity={showDensity} densityTracks={densityTracks} densityMetric={densityMetric} densityAltitudeMin={densityAltitudeMin} densityAltitudeMax={densityAltitudeMax} densityTooltipMode={densityTooltipMode} receiverLocation={receiverLocation} theme={mapTheme} />

        {/* History tracks — rendered first so active tracks layer on top */}
        {trajectoryStyle === "dots" && historyTracks.length > 0 && (
          <DotsLayer tracks={historyTracks} colorMode={historyColorMode} type="history" selectedHexIdents={selectedHexIdents} theme={mapTheme} />
        )}
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
        {trajectoryStyle === "dots" && dbHistoryTracks.length > 0 && (
          <DotsLayer tracks={dbHistoryTracks} colorMode="plot" type="dbHistory" selectedHexIdents={selectedHexIdents} theme={mapTheme} />
        )}
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
        {trajectoryStyle === "dots" && importedTracks.length > 0 && (
          <DotsLayer tracks={importedTracks} colorMode="plot" type="imported" selectedHexIdents={selectedHexIdents} theme={mapTheme} />
        )}
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
        {trajectoryStyle === "dots" && tracks.length > 0 && (
          <DotsLayer tracks={tracks} colorMode={liveColorMode} type="live" selectedHexIdents={selectedHexIdents} theme={mapTheme} />
        )}

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
              {t.positions.length > 1 && trajectoryStyle === "line" && (
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
      <AltitudeLegend theme={mapTheme} />
    </div>
  );
}

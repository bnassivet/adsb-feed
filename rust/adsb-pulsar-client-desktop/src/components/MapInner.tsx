"use client";
import { useEffect, useMemo, useCallback } from "react";
import { MapContainer, TileLayer, Marker, Polyline, GeoJSON, Tooltip, CircleMarker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { AircraftTrack, DensityMetric, DensityTooltipMode, AltitudeColorMode } from "@/lib/types";
import { zoomToH3Resolution } from "@/lib/types";
import { altitudeToColor, densityColor, cachedAltitudeToColor, type MapTheme } from "@/lib/colors";
import { computeH3Density } from "@/lib/h3-density";
import type { DensityProperties, DensityAltitudeRange } from "@/lib/h3-density";
import { useMapZoom } from "@/hooks/useMapZoom";
import { aircraftIconHtml } from "@/lib/aircraft-icon";
import { haversineDistanceNm } from "@/lib/geo";
import { orderTracksWithSelectedLast } from "@/lib/track-ordering";
import { MapTileToggle } from "./MapTileToggle";
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
  selectedHexIdent: string | null;
  onSelectTrack: (hex: string | null) => void;
  receiverLocation?: { lat: number; lng: number; alt: number | null };
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

/** Extract [lat, lng] pairs from position tuples for Leaflet Polyline. */
function toLatLngs(positions: [number, number, number | null][]): [number, number][] {
  return positions.map(p => [p[0], p[1]]);
}

/** Renders dots imperatively via Leaflet API — bypasses React per-dot reconciliation. */
function DotsLayer({
  tracks,
  colorMode,
  type,
  selectedHexIdent,
  theme,
}: {
  tracks: AircraftTrack[];
  colorMode: AltitudeColorMode;
  type: "history" | "live" | "imported" | "dbHistory";
  selectedHexIdent: string | null;
  theme: MapTheme;
}) {
  const map = useMap();

  useEffect(() => {
    const markers: L.CircleMarker[] = [];
    const baseRadius = type === "history" ? 2 : type === "imported" ? 2.5 : type === "dbHistory" ? 2.5 : 3;
    const baseFillOpacity = type === "history" ? 0.2 : type === "imported" ? 0.35 : type === "dbHistory" ? 0.4 : 0.6;

    for (const t of tracks) {
      if (t.positions.length < 2) continue;
      const trackColor = cachedAltitudeToColor(t.altitude, theme);
      const isSelected = t.hex_ident === selectedHexIdent;
      const radius = isSelected ? baseRadius + 2 : baseRadius;
      const fillOpacity = isSelected ? 0.9 : baseFillOpacity;

      for (let i = 0; i < t.positions.length; i++) {
        const pos = t.positions[i];
        const dotColor = colorMode === "plot" ? cachedAltitudeToColor(pos[2], theme) : trackColor;
        const isLast = i === t.positions.length - 1;

        const marker = L.circleMarker([pos[0], pos[1]], {
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
              `<div>Alt: <span style="color:#fff">${formatAlt(pos[2])}</span></div>`,
            ];
            if (isLast) parts.push(`<div>Last seen: ${timeAgo(t.last_seen)}</div>`);
            return parts.join("");
          });
        } else if (type === "dbHistory") {
          marker.bindTooltip(() =>
            `<div style="font-weight:600;color:#fff">${label}</div><div>Hex: ${t.hex_ident}</div><div>Alt: <span style="color:#fff">${formatAlt(pos[2])}</span></div><div style="color:#22d3ee;margin-top:2px">DB History</div>`
          );
        } else if (type === "imported") {
          marker.bindTooltip(() =>
            `<div style="font-weight:600;color:#fff">${label}</div><div>Hex: ${t.hex_ident}</div><div>Alt: <span style="color:#fff">${formatAlt(pos[2])}</span></div><div style="color:#818cf8;margin-top:2px">Imported</div>`
          );
        } else {
          marker.bindTooltip(() =>
            `<div style="font-weight:600;color:#fff">${label}</div><div>Alt: <span style="color:#fff">${formatAlt(pos[2])}</span></div>`
          );
        }

        marker.addTo(map);
        markers.push(marker);
      }
    }

    return () => {
      for (const m of markers) {
        m.remove();
      }
    };
  }, [map, tracks, colorMode, type, selectedHexIdent, theme]);

  return null;
}

export function MapInner({ tracks, historyTracks, dbHistoryTracks = [], importedTracks = [], mapTheme, onToggleTheme, trajectoryStyle, showDensity, densityMetric, densityTracks, densityAltitudeMin, densityAltitudeMax, densityTooltipMode, liveColorMode, historyColorMode, selectedHexIdent, onSelectTrack, receiverLocation }: Props) {
  const tile = TILE_CONFIGS[mapTheme];
  const mapCenter: [number, number] = receiverLocation
    ? [receiverLocation.lat, receiverLocation.lng]
    : DEFAULT_CENTER;

  // Reorder tracks so selected renders on top (last in array = top layer)
  const orderedTracks = useMemo(
    () => orderTracksWithSelectedLast(tracks, selectedHexIdent),
    [tracks, selectedHexIdent],
  );
  const orderedHistory = useMemo(
    () => orderTracksWithSelectedLast(historyTracks, selectedHexIdent),
    [historyTracks, selectedHexIdent],
  );

  const handleDeselect = useCallback(() => onSelectTrack(null), [onSelectTrack]);

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
        <TileLayer
          key={mapTheme}
          attribution={tile.attribution}
          url={tile.url}
        />

        {/* Density hexagons — zoom-adaptive H3 resolution */}
        <DensityLayer showDensity={showDensity} densityTracks={densityTracks} densityMetric={densityMetric} densityAltitudeMin={densityAltitudeMin} densityAltitudeMax={densityAltitudeMax} densityTooltipMode={densityTooltipMode} receiverLocation={receiverLocation} theme={mapTheme} />

        {/* History tracks — rendered first so active tracks layer on top */}
        {trajectoryStyle === "dots" && historyTracks.length > 0 && (
          <DotsLayer tracks={historyTracks} colorMode={historyColorMode} type="history" selectedHexIdent={selectedHexIdent} theme={mapTheme} />
        )}
        {trajectoryStyle === "line" && orderedHistory.map((t) => {
          if (t.positions.length < 2) return null;
          const trackColor = cachedAltitudeToColor(t.altitude, mapTheme);
          const isSelected = t.hex_ident === selectedHexIdent;

          return (
            <Polyline
              key={`hist-${t.hex_ident}`}
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
          <DotsLayer tracks={dbHistoryTracks} colorMode="plot" type="dbHistory" selectedHexIdent={selectedHexIdent} theme={mapTheme} />
        )}
        {trajectoryStyle === "line" && dbHistoryTracks.map((t) => {
          if (t.positions.length < 2) return null;
          const isSelected = t.hex_ident === selectedHexIdent;
          return (
            <Polyline
              key={`dbhist-${t.hex_ident}`}
              positions={toLatLngs(t.positions)}
              pathOptions={{
                color: "#06b6d4",
                weight: isSelected ? 3 : 2,
                opacity: isSelected ? 0.8 : 0.5,
              }}
              eventHandlers={{ click: () => onSelectTrack(t.hex_ident) }}
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
          <DotsLayer tracks={importedTracks} colorMode="plot" type="imported" selectedHexIdent={selectedHexIdent} theme={mapTheme} />
        )}
        {trajectoryStyle === "line" && importedTracks.map((t) => {
          if (t.positions.length < 2) return null;
          const isSelected = t.hex_ident === selectedHexIdent;
          return (
            <Polyline
              key={`imported-${t.hex_ident}`}
              positions={toLatLngs(t.positions)}
              pathOptions={{
                color: "#818cf8",
                weight: isSelected ? 3 : 2,
                opacity: isSelected ? 0.8 : 0.5,
                dashArray: isSelected ? undefined : "6 4",
              }}
              eventHandlers={{ click: () => onSelectTrack(t.hex_ident) }}
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
          <DotsLayer tracks={tracks} colorMode={liveColorMode} type="live" selectedHexIdent={selectedHexIdent} theme={mapTheme} />
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

        {/* Active tracks — aircraft markers and line trajectories */}
        {orderedTracks.map((t) => {
          if (t.latitude === null || t.longitude === null) return null;
          const trackColor = cachedAltitudeToColor(t.altitude, mapTheme);
          const isSelected = t.hex_ident === selectedHexIdent;
          const icon = aircraftIcon(t.track ?? 0, trackColor, isSelected);

          return (
            <div key={t.hex_ident}>
              <Marker
                position={[t.latitude, t.longitude]}
                icon={icon}
                eventHandlers={{ click: () => onSelectTrack(t.hex_ident) }}
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
      <AltitudeLegend theme={mapTheme} />
    </div>
  );
}

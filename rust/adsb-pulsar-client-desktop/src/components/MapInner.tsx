"use client";
import { useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Polyline, GeoJSON, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import type { AircraftTrack, DensityMetric, AltitudeColorMode } from "@/lib/types";
import { zoomToH3Resolution } from "@/lib/types";
import { altitudeToColor, densityColor, cachedAltitudeToColor } from "@/lib/colors";
import { computeH3Density } from "@/lib/h3-density";
import type { DensityProperties } from "@/lib/h3-density";
import { useMapZoom } from "@/hooks/useMapZoom";
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

/** Creates a rotated triangle SVG icon for an aircraft. */
function aircraftIcon(heading: number, color: string): L.DivIcon {
  const svg = `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <g transform="rotate(${heading}, 12, 12)">
      <polygon points="12,2 6,20 12,16 18,20" fill="${color}" stroke="#000" stroke-width="1" opacity="0.9"/>
    </g>
  </svg>`;

  return L.divIcon({
    html: svg,
    className: "",
    iconSize: [24, 24],
    iconAnchor: [12, 12],
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

interface Props {
  tracks: AircraftTrack[];
  historyTracks: AircraftTrack[];
  mapTheme: "light" | "dark";
  onToggleTheme: () => void;
  trajectoryStyle: "line" | "dots";
  showDensity: boolean;
  densityMetric: DensityMetric;
  densityTracks: AircraftTrack[];
  liveColorMode: AltitudeColorMode;
  historyColorMode: AltitudeColorMode;
}

/** Renders H3 density hexagons with zoom-adaptive resolution. */
function DensityLayer({
  showDensity,
  densityTracks,
  densityMetric,
}: {
  showDensity: boolean;
  densityTracks: AircraftTrack[];
  densityMetric: DensityMetric;
}) {
  const zoom = useMapZoom(300);
  const resolution = zoomToH3Resolution(zoom);

  const densityGeoJson = useMemo(
    () => (showDensity ? computeH3Density(densityTracks, densityMetric, resolution) : null),
    [showDensity, densityTracks, densityMetric, resolution],
  );

  // react-leaflet's GeoJSON doesn't re-render on data change — use key to force remount
  const densityKey = densityGeoJson
    ? `density-${densityMetric}-${resolution}-${densityGeoJson.features.length}-${densityTracks.length}`
    : "density-off";

  if (!densityGeoJson || densityGeoJson.features.length === 0) return null;

  return (
    <GeoJSON
      key={densityKey}
      data={densityGeoJson}
      style={(feature) => {
        const props = (feature?.properties ?? { normalized: 0, value: 0 }) as DensityProperties;
        if (densityMetric === "altitude") {
          const c = altitudeToColor(props.value);
          return { color: c, fillColor: c, fillOpacity: 0.08, weight: 1, opacity: 0.2 };
        }
        const { color, fillOpacity } = densityColor(props.normalized);
        return { color, fillColor: color, fillOpacity, weight: 1, opacity: 0.4 };
      }}
      onEachFeature={(feature, layer) => {
        const props = feature.properties as DensityProperties;
        let text: string;
        if (densityMetric === "altitude") {
          text = `Mean alt: ${Math.round(props.value).toLocaleString()} ft`;
        } else {
          const label = densityMetric === "positions" ? "Positions" : "Aircraft";
          text = `${label}: ${props.value}`;
        }
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
}: {
  tracks: AircraftTrack[];
  colorMode: AltitudeColorMode;
  type: "history" | "live";
}) {
  const map = useMap();

  useEffect(() => {
    const markers: L.CircleMarker[] = [];
    const radius = type === "history" ? 2 : 3;
    const fillOpacity = type === "history" ? 0.2 : 0.6;

    for (const t of tracks) {
      if (t.positions.length < 2) continue;
      const trackColor = cachedAltitudeToColor(t.altitude);

      for (let i = 0; i < t.positions.length; i++) {
        const pos = t.positions[i];
        const dotColor = colorMode === "plot" ? cachedAltitudeToColor(pos[2]) : trackColor;
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
              `<div class="text-xs">`,
              `<div class="font-bold">${label}</div>`,
              `<div>Hex: ${t.hex_ident}</div>`,
              `<div>Alt: ${formatAlt(pos[2])}</div>`,
            ];
            if (isLast) parts.push(`<div>Last seen: ${timeAgo(t.last_seen)}</div>`);
            parts.push(`</div>`);
            return parts.join("");
          });
        } else {
          marker.bindTooltip(() =>
            `<div class="text-xs"><div class="font-bold">${label}</div><div>Alt: ${formatAlt(pos[2])}</div></div>`
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
  }, [map, tracks, colorMode, type]);

  return null;
}

export function MapInner({ tracks, historyTracks, mapTheme, onToggleTheme, trajectoryStyle, showDensity, densityMetric, densityTracks, liveColorMode, historyColorMode }: Props) {
  const tile = TILE_CONFIGS[mapTheme];

  return (
    <div className="h-full w-full relative">
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        className="h-full w-full"
        zoomControl={true}
        preferCanvas={true}
      >
        <MapResizeHandler />
        <TileLayer
          key={mapTheme}
          attribution={tile.attribution}
          url={tile.url}
        />

        {/* Density hexagons — zoom-adaptive H3 resolution */}
        <DensityLayer showDensity={showDensity} densityTracks={densityTracks} densityMetric={densityMetric} />

        {/* History tracks — rendered first so active tracks layer on top */}
        {trajectoryStyle === "dots" && historyTracks.length > 0 && (
          <DotsLayer tracks={historyTracks} colorMode={historyColorMode} type="history" />
        )}
        {trajectoryStyle === "line" && historyTracks.map((t) => {
          if (t.positions.length < 2) return null;
          const trackColor = cachedAltitudeToColor(t.altitude);

          return (
            <Polyline
              key={`hist-${t.hex_ident}`}
              positions={toLatLngs(t.positions)}
              pathOptions={{
                color: trackColor,
                weight: 1,
                opacity: 0.25,
              }}
            >
              <Tooltip sticky>
                <div className="text-xs">
                  <div className="font-bold">
                    {t.callsign ?? t.hex_ident}
                  </div>
                  <div>Hex: {t.hex_ident}</div>
                  <div>Alt: {formatAlt(t.altitude)}</div>
                  <div>Last seen: {timeAgo(t.last_seen)}</div>
                </div>
              </Tooltip>
            </Polyline>
          );
        })}

        {/* Active track dots — imperative layer for performance */}
        {trajectoryStyle === "dots" && tracks.length > 0 && (
          <DotsLayer tracks={tracks} colorMode={liveColorMode} type="live" />
        )}

        {/* Active tracks — aircraft markers and line trajectories */}
        {tracks.map((t) => {
          if (t.latitude === null || t.longitude === null) return null;
          const trackColor = cachedAltitudeToColor(t.altitude);
          const icon = aircraftIcon(t.track ?? 0, trackColor);

          return (
            <div key={t.hex_ident}>
              <Marker
                position={[t.latitude, t.longitude]}
                icon={icon}
              >
                <Tooltip direction="top" offset={[0, -12]}>
                  <div className="text-xs">
                    <div className="font-bold">
                      {t.callsign ?? t.hex_ident}
                    </div>
                    <div>Hex: {t.hex_ident}</div>
                    {t.altitude !== null && (
                      <div>Alt: {t.altitude.toLocaleString()} ft</div>
                    )}
                    {t.ground_speed !== null && (
                      <div>Spd: {t.ground_speed.toFixed(0)} kts</div>
                    )}
                    {t.squawk !== null && <div>Sqk: {t.squawk}</div>}
                  </div>
                </Tooltip>
              </Marker>

              {/* Line trajectory */}
              {t.positions.length > 1 && trajectoryStyle === "line" && (
                <Polyline
                  positions={toLatLngs(t.positions)}
                  pathOptions={{
                    color: trackColor,
                    weight: 2,
                    opacity: 0.6,
                  }}
                />
              )}
            </div>
          );
        })}
      </MapContainer>

      <MapTileToggle theme={mapTheme} onToggle={onToggleTheme} />
      <AltitudeLegend />
    </div>
  );
}

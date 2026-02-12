"use client";
import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Polyline, CircleMarker, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import type { AircraftTrack } from "@/lib/types";
import { altitudeToColor } from "@/lib/colors";
import { MapTileToggle } from "./MapTileToggle";

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
  mapTheme: "light" | "dark";
  onToggleTheme: () => void;
  trajectoryStyle: "line" | "dots";
}

export function MapInner({ tracks, mapTheme, onToggleTheme, trajectoryStyle }: Props) {
  const tile = TILE_CONFIGS[mapTheme];

  return (
    <div className="h-full w-full relative">
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        className="h-full w-full"
        zoomControl={true}
      >
        <MapResizeHandler />
        <TileLayer
          key={mapTheme}
          attribution={tile.attribution}
          url={tile.url}
        />

        {tracks.map((t) => {
          if (t.latitude === null || t.longitude === null) return null;
          const color = altitudeToColor(t.altitude);
          const icon = aircraftIcon(t.track ?? 0, color);

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

              {/* Trajectory */}
              {t.positions.length > 1 && trajectoryStyle === "line" && (
                <Polyline
                  positions={t.positions as [number, number][]}
                  pathOptions={{
                    color,
                    weight: 2,
                    opacity: 0.6,
                  }}
                />
              )}
              {t.positions.length > 1 && trajectoryStyle === "dots" &&
                (t.positions as [number, number][]).map((pos, i) => (
                  <CircleMarker
                    key={i}
                    center={pos}
                    radius={3}
                    pathOptions={{
                      color,
                      fillColor: color,
                      fillOpacity: 0.6,
                      weight: 0,
                    }}
                  />
                ))
              }
            </div>
          );
        })}
      </MapContainer>

      <MapTileToggle theme={mapTheme} onToggle={onToggleTheme} />
    </div>
  );
}

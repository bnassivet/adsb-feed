"use client";
import { MapContainer, TileLayer, Marker, Polyline, Tooltip } from "react-leaflet";
import L from "leaflet";
import type { AircraftTrack } from "@/lib/types";
import { altitudeToColor } from "@/lib/colors";

// Default center: Montreal
const DEFAULT_CENTER: [number, number] = [45.5, -73.6];
const DEFAULT_ZOOM = 8;

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

interface Props {
  tracks: AircraftTrack[];
}

export function MapInner({ tracks }: Props) {
  return (
    <MapContainer
      center={DEFAULT_CENTER}
      zoom={DEFAULT_ZOOM}
      className="h-full w-full"
      zoomControl={true}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
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

            {/* Trajectory line */}
            {t.positions.length > 1 && (
              <Polyline
                positions={t.positions as [number, number][]}
                pathOptions={{
                  color,
                  weight: 2,
                  opacity: 0.6,
                }}
              />
            )}
          </div>
        );
      })}
    </MapContainer>
  );
}

"use client";
import { useMemo } from "react";
import { CircleMarker, Marker, Polyline, Rectangle, Tooltip } from "react-leaflet";
import L from "leaflet";
import { aircraftIconHtml } from "@/lib/aircraft-icon";
import { cachedAltitudeToColor, type MapTheme } from "@/lib/colors";
import { openSkyWaypointTooltipHtml } from "@/lib/dot-tooltip";
import { externalTrackPoints, type OpenSkyMapData, type OpenSkyPoint } from "@/lib/opensky";
import { selectingPath, type TrackMenuOpener } from "@/lib/selectable-path";
import { trackKey } from "@/lib/types";

/** The OpenSky layer's colour, for everything that is not an aircraft. */
export const OPENSKY_COLOR = "#a78bfa";

interface Props {
  data: OpenSkyMapData;
  selectedHexIdents: Set<string>;
  onSelectTrack: (key: string) => void;
  onTrackContextMenu?: TrackMenuOpener;
  theme: MapTheme;
  nowMs: number;
}

function hollowIcon(heading: number, color: string, selected: boolean): L.DivIcon {
  const r = aircraftIconHtml(heading, color, selected, { hollow: true });
  return L.divIcon({ html: r.html, className: r.className, iconSize: r.iconSize, iconAnchor: r.iconAnchor });
}

/**
 * The positions OpenSky filled in, as dots: filled by altitude like the
 * receiver's points, ringed in violet to say where they came from, with the
 * receiver's dot tooltip and OpenSky as its source.
 */
function OpenSkyDots({
  flight,
  points,
  theme,
  selected,
  selectKey,
  onSelect,
  onMenu,
}: {
  flight: { hex: string; callsign: string | null };
  points: OpenSkyPoint[];
  theme: MapTheme;
  selected: boolean;
  /** The flight the dots belong to, selected on click. */
  selectKey: string;
  onSelect: (key: string) => void;
  onMenu?: TrackMenuOpener;
}) {
  return (
    <>
      {points.map((p, i) => (
        <CircleMarker
          key={`${p.time}-${i}`}
          center={[p.lat, p.lng]}
          radius={selected ? 4 : 3}
          {...selectingPath(selectKey, onSelect, onMenu)}
          pathOptions={{
            color: OPENSKY_COLOR,
            weight: 1,
            fillColor: cachedAltitudeToColor(p.altitude, theme),
            fillOpacity: 0.9,
          }}
        >
          {/* Escaped by the builder: callsigns come off the air. */}
          <Tooltip direction="auto" opacity={0.9}>
            <div dangerouslySetInnerHTML={{ __html: openSkyWaypointTooltipHtml(flight, p.altitude, p.time) }} />
          </Tooltip>
        </CircleMarker>
      ))}
    </>
  );
}

/**
 * OpenSky aircraft and areas. Distinct from the receiver's own traffic at a
 * glance: hollow dashed aircraft, dashed trails, violet areas and gap
 * connectors, and every position OpenSky filled in as a dot. A click on any
 * line or dot selects the flight it belongs to: the recorded one for a flight
 * history, the aircraft for a backfill or a live trail. Never part of the live
 * store; recorded only in the opensky_* tables.
 */
export function OpenSkyLayer({ data, selectedHexIdents, onSelectTrack, onTrackContextMenu, theme, nowMs }: Props) {
  const tracks = useMemo(
    // Selected last, so they draw on top.
    () => [...data.tracks].sort((a, b) => Number(selectedHexIdents.has(trackKey(a))) - Number(selectedHexIdents.has(trackKey(b)))),
    [data.tracks, selectedHexIdents],
  );

  return (
    <>
      {data.areas.map((a) => (
        <Rectangle
          key={`osky-area-${a.id}`}
          bounds={[[a.south, a.west], [a.north, a.east]]}
          pathOptions={{ color: OPENSKY_COLOR, weight: 1.5, dashArray: "6 4", fillOpacity: 0.04 }}
        >
          <Tooltip sticky>
            <div style={{ fontSize: 11 }}>
              <div style={{ fontWeight: 600, color: OPENSKY_COLOR }}>OpenSky area {a.id}</div>
            </div>
          </Tooltip>
        </Rectangle>
      ))}

      {data.backfills.map((b) => {
        const selected = selectedHexIdents.has(b.selectKey);
        return (
          <div key={`osky-backfill-${b.hex}`}>
            <Polyline
              positions={b.path}
              {...selectingPath(b.selectKey, onSelectTrack, onTrackContextMenu)}
              pathOptions={{ color: OPENSKY_COLOR, weight: selected ? 3 : 2, opacity: 0.7, dashArray: "2 6" }}
            />
            <OpenSkyDots
              flight={b}
              points={b.points}
              theme={theme}
              selected={selected}
              selectKey={b.selectKey}
              onSelect={onSelectTrack}
              onMenu={onTrackContextMenu}
            />
          </div>
        );
      })}

      {data.history.map((h) => {
        const selected = selectedHexIdents.has(h.selectKey);
        return (
          <div key={`osky-history-${h.key}`}>
            <Polyline
              positions={h.path}
              {...selectingPath(h.selectKey, onSelectTrack, onTrackContextMenu)}
              pathOptions={{ color: OPENSKY_COLOR, weight: selected ? 3 : 2, opacity: 0.7, dashArray: "2 6" }}
            />
            {/* What OpenSky adds: stretches the receiver has nothing near. */}
            {h.gaps.map((g, i) => (
              <Polyline
                key={i}
                positions={g}
                {...selectingPath(h.selectKey, onSelectTrack, onTrackContextMenu)}
                pathOptions={{ color: OPENSKY_COLOR, weight: selected ? 4 : 3, opacity: 0.9 }}
              />
            ))}
            <OpenSkyDots
              flight={h}
              points={h.waypoints}
              theme={theme}
              selected={selected}
              selectKey={h.selectKey}
              onSelect={onSelectTrack}
              onMenu={onTrackContextMenu}
            />
          </div>
        );
      })}

      {data.connectors.map((c) => (
        <Polyline
          key={`osky-gap-${c.hex}`}
          positions={[c.from, c.to]}
          pathOptions={{ color: OPENSKY_COLOR, weight: 2, opacity: 0.8, dashArray: "4 6" }}
        />
      ))}

      {tracks.map((t) => {
        if (t.latitude == null || t.longitude == null) return null;
        const key = trackKey(t);
        const selected = selectedHexIdents.has(key) || selectedHexIdents.has(t.hex_ident);
        const color = cachedAltitudeToColor(t.altitude, theme);
        const trail = (t.positions as [number, number, number | null][]).map(
          ([lat, lng]) => [lat, lng] as [number, number],
        );
        const ageS = Math.max(0, Math.round((nowMs - t.last_seen) / 1000));
        return (
          <div key={key}>
            {trail.length > 1 && (
              <Polyline
                positions={trail}
                {...selectingPath(key, onSelectTrack, onTrackContextMenu)}
                pathOptions={{ color, weight: selected ? 3 : 1.5, opacity: 0.75, dashArray: "5 5" }}
              />
            )}
            <OpenSkyDots
              flight={{ hex: t.hex_ident, callsign: t.callsign }}
              points={externalTrackPoints(t)}
              theme={theme}
              selected={selected}
              selectKey={key}
              onSelect={onSelectTrack}
              onMenu={onTrackContextMenu}
            />
            <Marker
              position={[t.latitude, t.longitude]}
              icon={hollowIcon(t.track ?? 0, color, selected)}
              eventHandlers={selectingPath(key, onSelectTrack, onTrackContextMenu).eventHandlers}
            >
              <Tooltip direction="top" offset={[0, -12]}>
                <div style={{ fontSize: 11 }}>
                  <div style={{ fontWeight: 600, color: OPENSKY_COLOR }}>
                    {t.callsign ?? t.hex_ident} · OpenSky
                  </div>
                  <div>Hex: {t.hex_ident}</div>
                  {t.altitude !== null && <div>Alt: {Math.round(t.altitude).toLocaleString()} ft</div>}
                  {t.ground_speed !== null && <div>Spd: {t.ground_speed.toFixed(0)} kts</div>}
                  <div style={{ color: "#94a3b8" }}>Position {ageS} s old</div>
                </div>
              </Tooltip>
            </Marker>
          </div>
        );
      })}
    </>
  );
}

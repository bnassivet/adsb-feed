"use client";
import dynamic from "next/dynamic";
import type { AircraftTrack, DensityMetric, DensityTooltipMode, AltitudeColorMode, EventOfInterest, MapPickResult, RejectedPosition } from "@/lib/types";
import type { AgentTrajectory } from "@/lib/simulation-data";
import type { WeatherLevel, WeatherSnapshot } from "@/lib/weather";
import type { ReceiverPoint } from "@/lib/aircraft-details";
import type { OtherReceiver } from "./MapInner";
import type { Airspace } from "@/lib/airspace";
import type { Metar } from "@/lib/metar";
import type { RadarView } from "@/lib/radar";
import type { SeaSettings } from "@/lib/sea";
import type { Seamark } from "@/lib/seamark";

// Dynamic import to prevent SSR (Leaflet requires window/document)
const MapInner = dynamic(
  () => import("./MapInner").then((mod) => mod.MapInner),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full flex items-center justify-center bg-slate-900 text-slate-500">
        Loading map...
      </div>
    ),
  },
);

interface Props {
  /** OpenAIP airspaces to draw; empty or absent while the layer is off. */
  airspaces?: Airspace[];
  /** Airspace slider, 0–1. */
  airspaceOpacity?: number;
  /** List the airspaces under the cursor. */
  airspaceHoverInfo?: boolean;
  metars?: Metar[];
  metarOpacity?: number;
  metarHoverInfo?: boolean;
  metarNowMs?: number;
  radar?: RadarView | null;
  radarOpacity?: number;
  sea?: SeaSettings;
  seamarkItems?: Seamark[];
  relief?: { show: boolean; opacity: number };
  onSeamarkCells?: (key: string | null) => void;
  tracks: AircraftTrack[];
  historyTracks: AircraftTrack[];
  mapTheme: "light" | "dark";
  onToggleTheme: () => void;
  trajectoryStyle: "line" | "dots";
  /** Draw the trail of past positions behind live aircraft. Defaults to true. */
  showPositions?: boolean;
  /** Draw `HEX/CALLSIGN` labels beside live aircraft. Defaults to false. */
  showLabels?: boolean;
  /** Receiver for range lines — not gated by "Show receiver". */
  rangeLineOrigin?: ReceiverPoint;
  /** Centre of the tile cache footprint — not gated by "Show receiver". */
  tileCacheOrigin?: ReceiverPoint;
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
  importedTracks?: AircraftTrack[];
  dbHistoryTracks?: AircraftTrack[];
  selectedHexIdents: Set<string>;
  onSelectTrack: (hex: string | null) => void;
  receiverLocation?: { lat: number; lng: number; alt: number | null };
  /** The database's other receivers, drawn dimmer than the selected one. */
  otherReceivers?: OtherReceiver[];
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
  /** Rejected positions to draw: point, label and H3 cell. */
  rejectedPositions?: RejectedPosition[];
}

export function Map({ airspaces, airspaceOpacity, airspaceHoverInfo, metars, metarOpacity, metarHoverInfo, metarNowMs, radar, radarOpacity, sea, seamarkItems, onSeamarkCells, relief, tracks, historyTracks, mapTheme, onToggleTheme, trajectoryStyle, showPositions, showLabels, rangeLineOrigin, tileCacheOrigin, rangeLineTargets, showRangeLines, onToggleRangeLines, showDensity, densityMetric, densityTracks, densityAltitudeMin, densityAltitudeMax, densityTooltipMode, liveColorMode, historyColorMode, importedTracks, dbHistoryTracks, selectedHexIdents, onSelectTrack, receiverLocation, otherReceivers, simulatedRoutes, eventsOfInterest, onContextMenu, mapPickingMode, onMapPickComplete, onMapPickCancel, onFlyToReady, weather, weatherLevel, weatherBarbs, weatherParticles, rejectedPositions }: Props) {
  return <MapInner airspaces={airspaces} airspaceOpacity={airspaceOpacity} airspaceHoverInfo={airspaceHoverInfo} metars={metars} metarOpacity={metarOpacity} metarHoverInfo={metarHoverInfo} metarNowMs={metarNowMs} radar={radar} radarOpacity={radarOpacity} sea={sea} seamarkItems={seamarkItems} onSeamarkCells={onSeamarkCells} relief={relief} tracks={tracks} historyTracks={historyTracks} mapTheme={mapTheme} onToggleTheme={onToggleTheme} trajectoryStyle={trajectoryStyle} showPositions={showPositions} showLabels={showLabels} rangeLineOrigin={rangeLineOrigin} tileCacheOrigin={tileCacheOrigin} rangeLineTargets={rangeLineTargets} showRangeLines={showRangeLines} onToggleRangeLines={onToggleRangeLines} showDensity={showDensity} densityMetric={densityMetric} densityTracks={densityTracks} densityAltitudeMin={densityAltitudeMin} densityAltitudeMax={densityAltitudeMax} densityTooltipMode={densityTooltipMode} liveColorMode={liveColorMode} historyColorMode={historyColorMode} importedTracks={importedTracks} dbHistoryTracks={dbHistoryTracks} selectedHexIdents={selectedHexIdents} onSelectTrack={onSelectTrack} receiverLocation={receiverLocation} otherReceivers={otherReceivers} simulatedRoutes={simulatedRoutes} eventsOfInterest={eventsOfInterest} onContextMenu={onContextMenu} mapPickingMode={mapPickingMode} onMapPickComplete={onMapPickComplete} onMapPickCancel={onMapPickCancel} onFlyToReady={onFlyToReady} weather={weather} weatherLevel={weatherLevel} weatherBarbs={weatherBarbs} weatherParticles={weatherParticles} rejectedPositions={rejectedPositions} />;
}

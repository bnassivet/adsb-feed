"use client";
import dynamic from "next/dynamic";
import type { AircraftTrack, DensityMetric, DensityTooltipMode, AltitudeColorMode } from "@/lib/types";

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
  tracks: AircraftTrack[];
  historyTracks: AircraftTrack[];
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
  importedTracks?: AircraftTrack[];
  dbHistoryTracks?: AircraftTrack[];
  selectedHexIdents: Set<string>;
  onSelectTrack: (hex: string | null) => void;
  receiverLocation?: { lat: number; lng: number; alt: number | null };
}

export function Map({ tracks, historyTracks, mapTheme, onToggleTheme, trajectoryStyle, showDensity, densityMetric, densityTracks, densityAltitudeMin, densityAltitudeMax, densityTooltipMode, liveColorMode, historyColorMode, importedTracks, dbHistoryTracks, selectedHexIdents, onSelectTrack, receiverLocation }: Props) {
  return <MapInner tracks={tracks} historyTracks={historyTracks} mapTheme={mapTheme} onToggleTheme={onToggleTheme} trajectoryStyle={trajectoryStyle} showDensity={showDensity} densityMetric={densityMetric} densityTracks={densityTracks} densityAltitudeMin={densityAltitudeMin} densityAltitudeMax={densityAltitudeMax} densityTooltipMode={densityTooltipMode} liveColorMode={liveColorMode} historyColorMode={historyColorMode} importedTracks={importedTracks} dbHistoryTracks={dbHistoryTracks} selectedHexIdents={selectedHexIdents} onSelectTrack={onSelectTrack} receiverLocation={receiverLocation} />;
}

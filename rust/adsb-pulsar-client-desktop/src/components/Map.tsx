"use client";
import dynamic from "next/dynamic";
import type { AircraftTrack, DensityMetric, AltitudeColorMode } from "@/lib/types";

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
  liveColorMode: AltitudeColorMode;
  historyColorMode: AltitudeColorMode;
  importedTracks?: AircraftTrack[];
  selectedHexIdent: string | null;
  onSelectTrack: (hex: string | null) => void;
}

export function Map({ tracks, historyTracks, mapTheme, onToggleTheme, trajectoryStyle, showDensity, densityMetric, densityTracks, liveColorMode, historyColorMode, importedTracks, selectedHexIdent, onSelectTrack }: Props) {
  return <MapInner tracks={tracks} historyTracks={historyTracks} mapTheme={mapTheme} onToggleTheme={onToggleTheme} trajectoryStyle={trajectoryStyle} showDensity={showDensity} densityMetric={densityMetric} densityTracks={densityTracks} liveColorMode={liveColorMode} historyColorMode={historyColorMode} importedTracks={importedTracks} selectedHexIdent={selectedHexIdent} onSelectTrack={onSelectTrack} />;
}

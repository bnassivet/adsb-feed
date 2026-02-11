"use client";
import dynamic from "next/dynamic";
import type { AircraftTrack } from "@/lib/types";

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
  mapTheme: "light" | "dark";
  onToggleTheme: () => void;
}

export function Map({ tracks, mapTheme, onToggleTheme }: Props) {
  return <MapInner tracks={tracks} mapTheme={mapTheme} onToggleTheme={onToggleTheme} />;
}

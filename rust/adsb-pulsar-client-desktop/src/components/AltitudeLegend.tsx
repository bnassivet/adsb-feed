"use client";
import { altitudeScaleStops, type MapTheme } from "@/lib/colors";

/** Vertical gradient bar showing the altitude-to-color mapping. */
export function AltitudeLegend({ theme }: { theme: MapTheme }) {
  // Build CSS gradient: top = high altitude (red), bottom = low altitude (blue)
  const stops = [...altitudeScaleStops(theme)].reverse();
  const gradient = stops
    .map((s, i) => `${s.color} ${Math.round((i / (stops.length - 1)) * 100)}%`)
    .join(", ");

  return (
    <div className="absolute top-32 right-2.5 z-[1000] flex items-start gap-1 pointer-events-none">
      {/* Gradient bar */}
      <div
        className="w-3 h-[120px] rounded-sm border border-white/30"
        style={{ background: `linear-gradient(to bottom, ${gradient})` }}
      />
      {/* Labels */}
      <div className="flex flex-col justify-between h-[120px] text-[10px] leading-none">
        <span className="text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">50k</span>
        <span className="text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">25k</span>
        <span className="text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">0</span>
      </div>
      <span className="text-[9px] text-white/70 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)] mt-0.5">ft</span>
    </div>
  );
}

"use client";
import type { MapTheme } from "@/lib/colors";
import { PARTICLE_COLORS, speedBucketLabel } from "@/lib/wind-particles";

const LABEL_CLASS = "text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]";

/**
 * Colour key for the wind particle layer, fastest at the top like the altitude
 * legend above it. Shown only while particles are drawn.
 */
export function WindSpeedLegend({ theme }: { theme: MapTheme }) {
  const colors = PARTICLE_COLORS[theme];
  const buckets = colors.map((_, bucket) => bucket).reverse();

  return (
    <div className="absolute top-[17rem] right-2.5 z-[1000] flex flex-col items-start gap-0.5 pointer-events-none text-[10px] leading-none">
      <span className={`text-[9px] text-white/70 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)] mb-0.5`}>kt</span>
      {buckets.map((bucket) => (
        <div key={bucket} className="flex items-center gap-1">
          <span
            data-testid="wind-speed-swatch"
            className="w-3 h-1.5 rounded-sm"
            style={{ backgroundColor: colors[bucket] }}
          />
          <span data-testid="wind-speed-label" className={LABEL_CLASS}>
            {speedBucketLabel(bucket)}
          </span>
        </div>
      ))}
    </div>
  );
}

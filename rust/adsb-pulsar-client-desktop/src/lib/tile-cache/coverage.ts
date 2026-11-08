import type { ZoomCoverage } from "./store";

/**
 * "z0–8 complete · z9 63% · z10 12%": the footprint's offline readiness in
 * one line. Percentages round down, so only a zoom with every tile reads as
 * complete.
 */
export function formatCoverage(levels: readonly ZoomCoverage[]): string {
  const parts: string[] = [];
  let runStart: number | null = null;
  let runEnd = 0;
  const closeRun = () => {
    if (runStart === null) return;
    parts.push(runStart === runEnd ? `z${runStart} complete` : `z${runStart}–${runEnd} complete`);
    runStart = null;
  };
  for (const { z, cached, total } of levels) {
    if (cached >= total) {
      runStart ??= z;
      runEnd = z;
      continue;
    }
    closeRun();
    parts.push(`z${z} ${Math.floor((cached / total) * 100)}%`);
  }
  closeRun();
  return parts.join(" · ");
}

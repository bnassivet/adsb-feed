/**
 * Shared color ramp for density displays (activity heatmap, radar density).
 *
 * Interpolates a value in [0, 1] from transparent dark → cyan → amber;
 * 0 is fully transparent so empty cells disappear.
 */
export function heatmapColor(t: number): string {
  if (t === 0) return "transparent";
  // 0→0.5: dark-slate → cyan
  if (t <= 0.5) {
    const s = t * 2; // 0→1
    const r = Math.round(15 + s * (6 - 15));
    const g = Math.round(23 + s * (182 - 23));
    const b = Math.round(42 + s * (212 - 42));
    return `rgba(${r}, ${g}, ${b}, ${0.3 + s * 0.5})`;
  }
  // 0.5→1: cyan → amber
  const s = (t - 0.5) * 2; // 0→1
  const r = Math.round(6 + s * (245 - 6));
  const g = Math.round(182 + s * (158 - 182));
  const b = Math.round(212 + s * (11 - 212));
  return `rgba(${r}, ${g}, ${b}, ${0.8 + s * 0.2})`;
}

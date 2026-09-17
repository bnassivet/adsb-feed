/**
 * Wind as pilots read it, shared by the map tooltip and the aircraft details
 * panel so the two never disagree on a direction.
 */
import type { Wind, WindComponents } from "./weather";

/** Three digits, and north as 360 -- never 000: `"070°"`, `"360°"`. */
export function formatWindDirection(dirDeg: number): string {
  const whole = Math.round(dirDeg) % 360 || 360;
  return `${String(whole).padStart(3, "0")}°`;
}

/** `"250° / 99 kt"` */
export function formatWind(wind: Wind): string {
  return `${formatWindDirection(wind.dirDeg)} / ${Math.round(wind.speedKt)} kt`;
}

/** `"85 kt headwind"`, `"40 kt tailwind"`, or `"no headwind"` when it rounds to zero. */
export function formatAlongTrack(components: WindComponents): string {
  const kt = Math.round(Math.abs(components.headwindKt));
  if (kt === 0) return "no headwind";
  return `${kt} kt ${components.headwindKt > 0 ? "headwind" : "tailwind"}`;
}

/** `"49 kt from the left"`, `"20 kt from the right"`, or `"no crosswind"`. */
export function formatCrosswind(components: WindComponents): string {
  const kt = Math.round(Math.abs(components.crosswindKt));
  if (kt === 0) return "no crosswind";
  return `${kt} kt from the ${components.crosswindKt > 0 ? "right" : "left"}`;
}

/**
 * Numeric form of the app's dark-theme altitude scale (`altitudeToColor` in
 * lib/colors.ts), for GPU variants that need bytes or interpolation stops
 * rather than `rgb()` strings. Pinned to the app by color.test.ts.
 */
export type Rgb = [number, number, number];

/** Piecewise-linear stops: exactly the four segments of altitudeToColorDark. */
export const ALTITUDE_STOPS: readonly (readonly [number, Rgb])[] = [
  [0, [0, 0, 255]],
  [12_500, [0, 255, 255]],
  [25_000, [0, 255, 0]],
  [37_500, [255, 255, 0]],
  [50_000, [255, 0, 0]],
];

export const NULL_ALT_RGB: Rgb = [0x88, 0x88, 0x88];
/** DB-history polyline colour in MapInner. */
export const LINE_RGB: Rgb = [0x06, 0xb6, 0xd4];

export function altitudeRgb(alt: number | null): Rgb {
  if (alt === null || Number.isNaN(alt)) return NULL_ALT_RGB;
  const a = Math.max(0, Math.min(50_000, alt));
  for (let i = 1; i < ALTITUDE_STOPS.length; i++) {
    const [a1, c1] = ALTITUDE_STOPS[i];
    if (a <= a1 || i === ALTITUDE_STOPS.length - 1) {
      const [a0, c0] = ALTITUDE_STOPS[i - 1];
      const t = (a - a0) / (a1 - a0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * t),
        Math.round(c0[1] + (c1[1] - c0[1]) * t),
        Math.round(c0[2] + (c1[2] - c0[2]) * t),
      ];
    }
  }
  return ALTITUDE_STOPS[ALTITUDE_STOPS.length - 1][1] as Rgb;
}

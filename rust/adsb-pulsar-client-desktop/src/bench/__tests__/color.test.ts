import { describe, it, expect } from "vitest";
import { altitudeToColor } from "@/lib/colors";
import { altitudeRgb, ALTITUDE_STOPS } from "@/bench/color";

function parse(rgb: string): [number, number, number] {
  if (rgb.startsWith("#")) {
    const n = parseInt(rgb.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)!;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

describe("altitudeRgb (GPU variants) matches the app's dark altitude scale", () => {
  it.each([0, 1, 3_000, 6_250, 12_499, 12_500, 20_000, 25_000, 31_000, 37_500, 44_000, 50_000, 60_000, -10])(
    "altitude %i",
    (alt) => {
      const [r, g, b] = altitudeRgb(alt);
      const [er, eg, eb] = parse(altitudeToColor(alt, "dark"));
      // altitudeToColor rounds; allow one unit of rounding difference.
      expect(Math.abs(r - er)).toBeLessThanOrEqual(1);
      expect(Math.abs(g - eg)).toBeLessThanOrEqual(1);
      expect(Math.abs(b - eb)).toBeLessThanOrEqual(1);
    },
  );

  it("is grey for a missing altitude, like the app", () => {
    expect(altitudeRgb(null)).toEqual(parse(altitudeToColor(null, "dark")));
    expect(altitudeRgb(NaN)).toEqual(parse(altitudeToColor(null, "dark")));
  });

  it("exposes the linear stops the MapLibre/OpenLayers expressions interpolate", () => {
    for (const [alt, rgb] of ALTITUDE_STOPS) {
      expect(altitudeRgb(alt)).toEqual(rgb);
    }
    expect(ALTITUDE_STOPS.map(([a]) => a)).toEqual([0, 12_500, 25_000, 37_500, 50_000]);
  });
});

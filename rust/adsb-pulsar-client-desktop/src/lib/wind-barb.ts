/**
 * Wind barb glyphs as SVG markup, for Leaflet `divIcon`s.
 *
 * Kept out of MapInner so the geometry is unit-tested: the map component
 * itself is not (Leaflet needs a real DOM layout).
 */
import { barbParts, type Wind } from "./weather";

/** Two decimals is plenty for a 32 px glyph, and keeps the markup short. */
function n(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * SVG for a wind barb centred on its grid point.
 *
 * Drawn pointing north, then rotated clockwise by the direction the wind blows
 * FROM, so the shaft points into the wind. Feathers sit on the east side of a
 * north-pointing shaft -- the northern-hemisphere convention -- starting at the
 * tip: 50 kt pennants, then 10 kt lines, then a 5 kt half line. Under 5 kt the
 * glyph is a circle with no shaft.
 */
export function windBarbSvg(wind: Wind, color: string, size: number = 32): string {
  const c = size / 2;
  const stroke = `stroke="${color}" stroke-width="${n(Math.max(1, size / 22))}" stroke-linecap="round"`;
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;

  const parts = barbParts(wind.speedKt);
  if (parts.calm) {
    return `${open}<circle cx="${n(c)}" cy="${n(c)}" r="${n(size * 0.14)}" fill="none" ${stroke}/></svg>`;
  }

  const tip = c - size * 0.46;
  const step = size * 0.11;
  const feather = size * 0.3;
  // Feathers lean back toward the tip, as on a printed chart.
  const lean = size * 0.09;

  const elements = [`<line x1="${n(c)}" y1="${n(c)}" x2="${n(c)}" y2="${n(tip)}" ${stroke}/>`];
  let y = tip;

  for (let i = 0; i < parts.pennants; i++) {
    elements.push(
      `<polygon points="${n(c)},${n(y)} ${n(c + feather)},${n(y)} ${n(c)},${n(y + step)}" fill="${color}" ${stroke}/>`,
    );
    y += step;
  }
  if (parts.pennants > 0) y += step * 0.4;

  for (let i = 0; i < parts.full; i++) {
    elements.push(
      `<line x1="${n(c)}" y1="${n(y)}" x2="${n(c + feather)}" y2="${n(y - lean)}" ${stroke}/>`,
    );
    y += step;
  }

  if (parts.half) {
    // A lone half barb sits one step down from the tip, so it is not mistaken
    // for the end of the shaft.
    if (parts.pennants === 0 && parts.full === 0) y += step;
    elements.push(
      `<line x1="${n(c)}" y1="${n(y)}" x2="${n(c + feather / 2)}" y2="${n(y - lean / 2)}" ${stroke}/>`,
    );
  }

  return `${open}<g transform="rotate(${n(wind.dirDeg)} ${n(c)} ${n(c)})">${elements.join("")}</g></svg>`;
}

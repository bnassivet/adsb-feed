/**
 * Canary for the deck.gl / MapLibre 6 shim (`exposeTransform`). It reads the
 * installed `@deck.gl/mapbox` and fails once that release stops reading
 * `map.transform` — the moment the shim can be deleted rather than carried.
 * See docs/MAP_ENGINES.md → Risks to carry.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Not require.resolve: both packages' `exports` hide package.json and dist/.
const pkgDir = (name: string) => join(process.cwd(), "node_modules", name);
const version = (name: string) => JSON.parse(readFileSync(join(pkgDir(name), "package.json"), "utf8")).version as string;

describe("deck.gl reads map.transform (exposeTransform still needed)", () => {
  const src = readFileSync(join(pkgDir("@deck.gl/mapbox"), "dist", "deck-utils.js"), "utf8");

  it("still reads map.transform; delete the shim when this fails", () => {
    expect(src).toMatch(/map\.transform\.(elevation|height)/);
  });

  it("MapLibre is still on the major that moved it", () => {
    // MapLibre ≤ 5 has map.transform, and exposeTransform is a no-op there.
    expect(Number(version("maplibre-gl").split(".")[0])).toBeGreaterThanOrEqual(6);
  });
});

import { describe, it, expect } from "vitest";
import { lngLatToTile, tilesInBbox, type Bbox } from "../tiles";
import { exposeTransform } from "../maplibre-compat";
import { benchStyle, CITY_BBOX, TERRAIN_BBOX, TERRAIN_MAXZOOM, BUILDINGS_MINZOOM, BUILDINGS_MAXZOOM } from "../maplibre-style";

describe("lngLatToTile", () => {
  it("puts the origin on the centre corner at z1", () => {
    expect(lngLatToTile(0.0001, -0.0001, 1)).toEqual({ z: 1, x: 1, y: 1 });
    expect(lngLatToTile(-0.0001, 0.0001, 1)).toEqual({ z: 1, x: 0, y: 0 });
  });

  it("clamps the world's edges into range", () => {
    expect(lngLatToTile(-180, 85.06, 3)).toEqual({ z: 3, x: 0, y: 0 });
    expect(lngLatToTile(180, -85.06, 3)).toEqual({ z: 3, x: 7, y: 7 });
  });

  it("matches a known tile (downtown Montréal, z15)", () => {
    // Computed independently with the slippy-map formula; also the tile the
    // Protomaps build answered with 1309 buildings.
    expect(lngLatToTile(-73.5673, 45.5017, 15)).toEqual({ z: 15, x: 9687, y: 11722 });
  });
});

describe("tilesInBbox", () => {
  it("covers the whole world at z2 with 16 tiles", () => {
    expect(tilesInBbox([-180, -85, 180, 85], 2, 2)).toHaveLength(16);
  });

  it("yields one tile per zoom for a box inside one tile", () => {
    const tiny: Bbox = [-73.57, 45.5, -73.569, 45.501];
    const t = tilesInBbox(tiny, 0, 5);
    expect(t.map((x) => x.z)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("is inclusive of both corner tiles", () => {
    const t = tilesInBbox([-0.1, -0.1, 0.1, 0.1], 1, 1);
    expect(t).toHaveLength(4);
  });
});

describe("benchStyle", () => {
  const base = "http://127.0.0.1:1234";

  it("is a background only by default", () => {
    const s = benchStyle({ base });
    expect(Object.keys(s.sources)).toEqual([]);
    expect(s.layers.map((l) => l.type)).toEqual(["background"]);
    expect(s.terrain).toBeUndefined();
  });

  it("adds 3D terrain and a hillshade from the Terrarium fixture", () => {
    const s = benchStyle({ base, terrain: true });
    const dems = Object.values(s.sources).filter((x) => x.type === "raster-dem");
    // MapLibre's own advice: separate DEM sources for terrain and hillshade.
    expect(dems).toHaveLength(2);
    for (const d of dems) {
      expect(d).toMatchObject({
        encoding: "terrarium",
        tiles: [`${base}/fixtures/terrarium/{z}/{x}/{y}.png`],
        maxzoom: TERRAIN_MAXZOOM,
        bounds: TERRAIN_BBOX,
      });
    }
    expect(s.terrain?.source).toBeDefined();
    expect(s.sources[s.terrain!.source].type).toBe("raster-dem");
    expect(s.layers.some((l) => l.type === "hillshade")).toBe(true);
  });

  it("extrudes buildings by height above min_height", () => {
    const s = benchStyle({ base, buildings: true });
    const osm = Object.values(s.sources).find((x) => x.type === "vector");
    expect(osm).toMatchObject({
      tiles: [`${base}/fixtures/protomaps/{z}/{x}/{y}.mvt`],
      maxzoom: BUILDINGS_MAXZOOM,
      bounds: CITY_BBOX,
    });
    const layer = s.layers.find((l) => l.type === "fill-extrusion");
    expect(layer).toMatchObject({ "source-layer": "buildings", minzoom: BUILDINGS_MINZOOM });
    const paint = (layer as { paint: Record<string, unknown> }).paint;
    expect(JSON.stringify(paint["fill-extrusion-height"])).toContain("height");
    expect(JSON.stringify(paint["fill-extrusion-base"])).toContain("min_height");
  });

  it("keeps the background first and the buildings on top", () => {
    const s = benchStyle({ base, terrain: true, buildings: true });
    expect(s.layers[0].type).toBe("background");
    expect(s.layers.at(-1)!.type).toBe("fill-extrusion");
  });
});

describe("exposeTransform (deck.gl 9.4 on MapLibre 6)", () => {
  it("re-exposes the camera's transform where deck.gl reads map.transform", () => {
    const transform = { elevation: 42, height: 800 };
    const map = { _camera: { transform } };
    exposeTransform(map);
    expect((map as unknown as { transform: typeof transform }).transform.elevation).toBe(42);
  });

  it("follows the camera's current transform, not a snapshot", () => {
    const map = { _camera: { transform: { elevation: 1 } } };
    exposeTransform(map);
    map._camera.transform = { elevation: 2 };
    expect((map as unknown as { transform: { elevation: number } }).transform.elevation).toBe(2);
  });

  it("leaves a map that already has a transform alone", () => {
    const own = { elevation: 7 };
    const map = { transform: own, _camera: { transform: { elevation: 0 } } };
    exposeTransform(map);
    expect(map.transform).toBe(own);
  });
});

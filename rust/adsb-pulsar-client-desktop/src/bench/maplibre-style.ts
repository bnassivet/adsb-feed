/**
 * MapLibre styles for the terrain and buildings benchmark, built on local
 * fixtures (`npm run bench:fixtures`) because the bench blocks the network.
 *
 * - Terrain: AWS Terrarium elevation tiles, z0–TERRAIN_MAXZOOM over TERRAIN_BBOX.
 *   MapLibre overzooms the DEM beyond that, which is also what an offline
 *   extract with a capped zoom would do.
 * - Buildings: OSM buildings from a Protomaps build, z0–15 over CITY_BBOX
 *   (downtown Montréal, the densest case near the bench centre).
 */
import type { StyleSpecification } from "maplibre-gl";
import type { Bbox } from "./tiles";

/** Around BENCH_CENTER (45.5, -73.6): wider than the pitched default view's near field. */
export const TERRAIN_BBOX: Bbox = [-78.6, 42, -68.6, 49];
export const TERRAIN_MAXZOOM = 9;

/** Downtown Montréal: the densest building tiles near the bench centre. */
export const CITY_BBOX: Bbox = [-73.63, 45.47, -73.51, 45.535];
export const CITY_VIEW = { center: [45.5017, -73.5673] as [number, number], maplibreZoom: 15 } as const;
export const BUILDINGS_MINZOOM = 13;
export const BUILDINGS_MAXZOOM = 15;

export interface BenchStyleOptions {
  /** Origin the driver serves `/fixtures/` from. */
  base: string;
  terrain?: boolean;
  buildings?: boolean;
}

export function benchStyle({ base, terrain = false, buildings = false }: BenchStyleOptions): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    sources: {},
    layers: [{ id: "bg", type: "background", paint: { "background-color": "#111" } }],
  };

  if (terrain) {
    const dem = {
      type: "raster-dem" as const,
      encoding: "terrarium" as const,
      tiles: [`${base}/fixtures/terrarium/{z}/{x}/{y}.png`],
      tileSize: 256,
      maxzoom: TERRAIN_MAXZOOM,
      bounds: [...TERRAIN_BBOX] as [number, number, number, number],
    };
    style.sources["dem-terrain"] = { ...dem };
    style.sources["dem-hillshade"] = { ...dem };
    style.layers.push({
      id: "hillshade",
      type: "hillshade",
      source: "dem-hillshade",
      paint: { "hillshade-shadow-color": "#000", "hillshade-highlight-color": "#444", "hillshade-accent-color": "#222" },
    });
    style.terrain = { source: "dem-terrain", exaggeration: 1 };
  }

  if (buildings) {
    style.sources.osm = {
      type: "vector",
      tiles: [`${base}/fixtures/protomaps/{z}/{x}/{y}.mvt`],
      maxzoom: BUILDINGS_MAXZOOM,
      bounds: [...CITY_BBOX] as [number, number, number, number],
    };
    style.layers.push({
      id: "buildings",
      type: "fill-extrusion",
      source: "osm",
      "source-layer": "buildings",
      minzoom: BUILDINGS_MINZOOM,
      paint: {
        "fill-extrusion-color": "#555",
        // Two thirds of OSM buildings carry no height: give them a storey or two.
        "fill-extrusion-height": ["coalesce", ["get", "height"], 6],
        "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
        "fill-extrusion-opacity": 0.9,
      },
    });
  }

  return style;
}

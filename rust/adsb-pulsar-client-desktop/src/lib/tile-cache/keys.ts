import type { TileCoord } from "./geometry";

/** Basemap providers the cache knows. Mirrors `TileConfig.provider` in `basemap.ts`. */
export type TileProvider = "osm" | "esri-dark" | "carto-dark";

/**
 * The cache key of a tile: `provider/z/x/y[@2x]`.
 *
 * Deliberately not the URL: the CARTO URL carries the API key, and a rotated key
 * must not orphan every tile already stored. Retina tiles are a different image,
 * so they get their own key.
 */
export function tileKey(provider: TileProvider, z: number, x: number, y: number, retina = false): string {
  return `${provider}/${z}/${x}/${y}${retina ? "@2x" : ""}`;
}

/**
 * Fill a Leaflet URL template for one tile, the way `L.TileLayer.getTileUrl`
 * does: `{s}` rotates through the subdomains by `(x + y)`, `{r}` is `@2x` for
 * retina. Used by prefetch, which has no Leaflet layer to ask.
 */
export function fillTileUrl(
  tile: { url: string; subdomains?: string },
  coord: TileCoord,
  retina: boolean,
): string {
  const subdomains = tile.subdomains ?? "abc";
  const s = subdomains[Math.abs(coord.x + coord.y) % subdomains.length];
  return tile.url
    .replace("{s}", s)
    .replace("{z}", String(coord.z))
    .replace("{x}", String(coord.x))
    .replace("{y}", String(coord.y))
    .replace("{r}", retina ? "@2x" : "");
}

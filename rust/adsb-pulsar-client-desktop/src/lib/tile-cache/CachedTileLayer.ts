import L from "leaflet";
import type { TileConfig } from "../basemap";
import { fillTileUrl, tileKey } from "./keys";
import { loadTile, type Footprint } from "./loadTile";
import { findCachedAncestor, renderCrop as drawCrop } from "./overzoom";
import type { TileStore } from "./store";

/**
 * What the layer needs to know at the moment it loads a tile. Read through a
 * getter on every tile, so a settings or receiver change applies to the next
 * tile without rebuilding the layer (which would reload the whole map).
 */
export interface CacheContext {
  /** A promise so tiles requested before the store has opened still use it. */
  store: Promise<TileStore | null>;
  enabled: boolean;
  footprint: Footprint | null;
  onStored?: () => void;
  onStoreError?: (error: unknown) => void;
}

/**
 * A Leaflet tile layer whose tiles go through the IndexedDB cache.
 *
 * Overrides `createTile` only. The URL is filled with `fillTileUrl`, the same
 * function prefetch uses, rather than `getTileUrl`: that one reads `z` from the
 * layer's internal state, and both must agree on the URL a key stands for.
 * Leaflet hands `createTile` coordinates already wrapped across the antimeridian.
 *
 * When a tile can be neither read nor fetched (offline, past the downloaded
 * zoom), it is cut from the nearest cached ancestor and scaled up.
 */
export interface CachedTileLayerDeps {
  /** Draws an ancestor crop as a full tile; canvas in the browser, a stand-in in tests. */
  renderCrop?: typeof drawCrop;
}

export function createCachedTileLayer(
  tile: TileConfig,
  context: () => CacheContext,
  { renderCrop = drawCrop }: CachedTileLayerDeps = {},
): L.TileLayer {
  const retina = L.Browser.retina && tile.url.includes("{r}");
  const pixels = retina ? 512 : 256;

  const CachedTileLayer = L.TileLayer.extend({
    createTile(coords: L.Coords, done: L.DoneCallback): HTMLImageElement {
      const img = document.createElement("img");
      img.alt = "";
      img.setAttribute("role", "presentation");
      L.DomEvent.on(img, "load", () => {
        if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
        done(undefined, img);
      });
      L.DomEvent.on(img, "error", (e) => done(e as unknown as Error, img));

      const coord = { z: coords.z, x: coords.x, y: coords.y };
      const url = fillTileUrl(tile, coord, retina);
      const ctx = context();
      void ctx.store.then(async (store) => {
        try {
          const blob = await loadTile({
            key: tileKey(tile.provider, coord.z, coord.x, coord.y, retina),
            provider: tile.provider,
            coord,
            url,
            store,
            enabled: ctx.enabled,
            footprint: ctx.footprint,
            onStored: ctx.onStored,
            onStoreError: ctx.onStoreError,
          });
          img.src = URL.createObjectURL(blob);
          return;
        } catch {
          // Network down (or a bad response): try the cached ancestor below.
        }
        try {
          const found = store && (await findCachedAncestor(store, tile.provider, coord, retina));
          if (found) {
            img.src = URL.createObjectURL(await renderCrop(found.blob, found.crop, pixels));
            return;
          }
        } catch {
          // No canvas, or an undecodable image: fall through.
        }
        // Let the browser try the plain URL (its HTTP cache may have it); if
        // that fails too, Leaflet's usual error handling takes over.
        img.src = url;
      });
      return img;
    },
    // `extend`'s typings drop the constructor signature; it is TileLayer's.
  }) as unknown as new (url: string, options?: L.TileLayerOptions) => L.TileLayer;

  return new CachedTileLayer(tile.url, {
    attribution: tile.attribution,
    maxZoom: tile.maxZoom,
    ...(tile.subdomains && { subdomains: tile.subdomains }),
  });
}

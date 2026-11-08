import { tileIntersectsCircle, type TileCoord } from "./geometry";
import type { TileProvider } from "./keys";
import type { TileStore } from "./store";
import { checkTile, type Placeholder } from "./validate";

/**
 * A cached tile older than this is refreshed in the background when online.
 * Never deleted for its age: offline, an old tile beats no tile.
 */
export const REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Keys being refreshed, so a tile on screen twice is fetched once. */
const refreshing = new Set<string>();

export interface Footprint {
  lat: number;
  lon: number;
  radiusNm: number;
}

export interface LoadTileOptions {
  key: string;
  provider: TileProvider;
  coord: TileCoord;
  /** The real upstream URL, key and all. */
  url: string;
  /** Null when IndexedDB is unavailable: the tile is fetched and nothing is cached. */
  store: Pick<TileStore, "get" | "put"> | null;
  /** Whether newly fetched tiles may be stored. Cached tiles are served regardless. */
  enabled: boolean;
  /** The receiver-centred circle; null (no receiver location) stores nothing. */
  footprint: Footprint | null;
  fetchFn?: typeof fetch;
  /** Called after a tile is stored, so the caller can schedule an eviction pass. */
  onStored?: () => void;
  /** Called when a tile could not be written (quota, a storage error). It is still shown. */
  onStoreError?: (error: unknown) => void;
  /** Tests only: placeholder fingerprints; defaults to the known ones. */
  placeholders?: readonly Placeholder[];
  /** Tests only: the clock. */
  now?: () => number;
  /** Tests only: whether the network is up; defaults to `navigator.onLine`. */
  isOnline?: () => boolean;
}

function browserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** Fetch `url` and keep the bytes only if they are a real image tile. */
async function fetchTile(opts: LoadTileOptions) {
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(opts.url, { mode: "cors" });
  if (!res.ok) throw new Error(`Tile ${opts.key}: HTTP ${res.status}`);
  const data = await res.arrayBuffer();
  const type = res.headers.get("content-type");
  const check = await checkTile(type, data, opts.placeholders);
  if (check === "not-image") throw new Error(`Tile ${opts.key}: not an image (${type ?? "no content type"})`);
  return { data, type: type!, check }; // checkTile: an image/* type
}

/** Replace a stale cached tile, quietly: any failure keeps the old one. */
function refreshInBackground(opts: LoadTileOptions, store: Pick<TileStore, "put">): void {
  if (refreshing.has(opts.key)) return;
  refreshing.add(opts.key);
  void fetchTile(opts)
    .then(async ({ data, type, check }) => {
      if (check !== "ok") return;
      try {
        await store.put({ key: opts.key, provider: opts.provider, ...opts.coord, data, type });
      } catch (e) {
        opts.onStoreError?.(e);
        return;
      }
      opts.onStored?.();
    })
    .catch(() => {}) // offline or upstream down: keep the old tile
    .finally(() => refreshing.delete(opts.key));
}

/**
 * Read-through load of one tile: the cache first, then the network.
 *
 * Caching is best-effort. A failed read falls through to the network and a
 * failed write (quota, a WebKit storage hiccup) still returns the tile -- the
 * map must never go blank because the cache misbehaved. A network failure
 * rejects, and so does a body that is not an image; a provider placeholder
 * (CARTO's "API KEY REQUIRED") is shown but never stored -- see `checkTile`.
 * Rejecting lets the layer fall back to a plain `<img src>` and Leaflet's
 * own error tile.
 */
export async function loadTile(opts: LoadTileOptions): Promise<Blob> {
  const { key, provider, coord, store, enabled, footprint } = opts;
  const now = opts.now ?? Date.now;
  const isOnline = opts.isOnline ?? browserOnline;

  if (store) {
    try {
      const hit = await store.get(key);
      if (hit) {
        if (now() - hit.storedAt > REFRESH_AFTER_MS && isOnline()) refreshInBackground(opts, store);
        return hit.blob;
      }
    } catch {
      // Unreadable cache: behave as a miss.
    }
  }

  const { data, type, check } = await fetchTile(opts);

  const shouldStore =
    check === "ok" &&
    store !== null &&
    enabled &&
    footprint !== null &&
    tileIntersectsCircle(coord.z, coord.x, coord.y, footprint.lat, footprint.lon, footprint.radiusNm);
  if (shouldStore) {
    try {
      // put() takes its own copy, so the Blob below may share `data`.
      await store.put({ key, provider, ...coord, data, type });
      opts.onStored?.();
    } catch (e) {
      // Not stored; still show it, and say so.
      opts.onStoreError?.(e);
    }
  }
  return new Blob([data], { type });
}

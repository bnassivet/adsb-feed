import { tilesInRadius } from "./geometry";
import { fillTileUrl, tileKey, type TileProvider } from "./keys";
import type { TileStore } from "./store";
import { isQuotaError } from "./health";
import { checkTile, type Placeholder } from "./validate";

/**
 * "Download area": fetch every tile of the footprint, coarse zooms first.
 *
 * Run as the window's single job (`prefetchJob.ts`), so it survives leaving
 * Settings but not closing the app. Coarse-first ordering means a cancelled or capped run still leaves a
 * usable low-zoom map of the whole area rather than a sharp corner of it.
 */

export class PrefetchRefusedError extends Error {
  constructor(provider: TileProvider) {
    super(
      provider === "osm"
        ? "OpenStreetMap's tile usage policy forbids bulk downloading. Viewed tiles are still cached."
        : `Bulk download is not allowed for ${provider}.`,
    );
    this.name = "PrefetchRefusedError";
  }
}

/** Providers whose terms forbid bulk download. Read-through caching still applies to them. */
export function prefetchAllowed(provider: TileProvider): boolean {
  return provider !== "osm";
}

/** `placeholder`: the provider answered with its "API key required" image, so every other tile would too. */
/** `storage-full`: the webview refused a write for lack of space, so the rest would be refused too. */
export type PrefetchStatus = "running" | "complete" | "cancelled" | "cap-reached" | "placeholder" | "storage-full";

export interface PrefetchProgress {
  total: number;
  /** Tiles dealt with: fetched, already cached, or failed. */
  done: number;
  /** Tiles downloaded by this run. */
  fetched: number;
  failed: number;
  /** Bytes downloaded by this run. */
  bytes: number;
  status: PrefetchStatus;
}

export interface PrefetchOptions {
  store: Pick<TileStore, "pinIfCached" | "put" | "stats">;
  tile: { provider: TileProvider; url: string; subdomains?: string; maxZoom: number };
  lat: number;
  lon: number;
  radiusNm: number;
  maxZoom: number;
  retina: boolean;
  /** The cache cap: the run stops rather than overflow it and evict its own work. */
  maxBytes: number;
  signal?: AbortSignal;
  onProgress?: (p: PrefetchProgress) => void;
  concurrency?: number;
  fetchFn?: typeof fetch;
  /** Called when a tile could not be written. */
  onStoreError?: (error: unknown) => void;
  /** Tests only: placeholder fingerprints; defaults to the known ones. */
  placeholders?: readonly Placeholder[];
}

export async function prefetchArea(opts: PrefetchOptions): Promise<PrefetchProgress> {
  const { store, tile, lat, lon, radiusNm, retina, signal, onProgress } = opts;
  if (!prefetchAllowed(tile.provider)) throw new PrefetchRefusedError(tile.provider);
  const fetchFn = opts.fetchFn ?? fetch;
  const maxZoom = Math.min(opts.maxZoom, tile.maxZoom);

  let total = 0;
  for (const t of tilesInRadius(lat, lon, radiusNm, maxZoom)) {
    void t;
    total++;
  }
  const progress: PrefetchProgress = { total, done: 0, fetched: 0, failed: 0, bytes: 0, status: "running" };
  let room = opts.maxBytes - (await store.stats()).bytes;
  const report = () => onProgress?.({ ...progress });
  report();

  const queue = tilesInRadius(lat, lon, radiusNm, maxZoom);
  const worker = async () => {
    for (;;) {
      if (signal?.aborted || progress.status !== "running") return;
      const next = queue.next();
      if (next.done) return;
      const coord = next.value;
      const key = tileKey(tile.provider, coord.z, coord.x, coord.y, retina && tile.url.includes("{r}"));
      try {
        // Already cached (by browsing or an earlier run): pin it rather than refetch.
        if (!(await store.pinIfCached(key))) {
          const res = await fetchFn(fillTileUrl(tile, coord, retina), { mode: "cors", signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.arrayBuffer();
          const type = res.headers.get("content-type");
          const check = await checkTile(type, data, opts.placeholders);
          if (check === "placeholder") {
            progress.status = "placeholder";
            return;
          }
          if (check === "not-image") throw new Error(`not an image (${type})`);
          if (data.byteLength > room) {
            progress.status = "cap-reached";
            return;
          }
          try {
            await store.put({
              key,
              provider: tile.provider,
              ...coord,
              data,
              type: type!, // checkTile: an image/* type
              pinned: true,
            });
          } catch (e) {
            opts.onStoreError?.(e);
            if (isQuotaError(e)) {
              progress.status = "storage-full";
              return;
            }
            throw e;
          }
          room -= data.byteLength;
          progress.fetched += 1;
          progress.bytes += data.byteLength;
        }
      } catch {
        if (signal?.aborted) return;
        progress.failed += 1;
      }
      progress.done += 1;
      report();
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  if (progress.status === "running") {
    progress.status = signal?.aborted ? "cancelled" : "complete";
  }
  report();
  return { ...progress };
}

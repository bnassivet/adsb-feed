import { tileIntersectsCircle, tilesInRadius } from "./geometry";
import type { TileProvider } from "./keys";

/**
 * IndexedDB-backed tile store.
 *
 * Two object stores share one key (`provider/z/x/y[@2x]`):
 * - `tiles`: the image bytes, as an ArrayBuffer + content type. Not a Blob:
 *   Blob-in-IndexedDB has a history of trouble in WebKit (the macOS webview),
 *   and a plain buffer clones everywhere.
 * - `meta`: `{provider, z, x, y, bytes, lastAccess, storedAt, pinned}`, indexed
 *   by `lastAccess`. Stats, LRU eviction and footprint pruning walk only this
 *   store, so sizing a 500 MB cache never pulls 500 MB of images into memory.
 *
 * Reads are read-only transactions, which IndexedDB runs concurrently; their
 * access times are kept in memory and written in one batch (`flushAccess`),
 * which eviction always runs first so LRU order stays exact.
 *
 * `pinned` marks tiles fetched by "Download area": eviction takes browsed
 * tiles first, so panning around never pushes out the area kept for offline
 * use. Records written before these fields existed read as unpinned and
 * `storedAt` 0 (due for a refresh).
 */

const DB_VERSION = 1;
const TILES = "tiles";
const META = "meta";
const BY_ACCESS = "lastAccess";
/** How long read access times wait in memory before one batched write. */
const ACCESS_FLUSH_MS = 2000;

export interface TilePut {
  key: string;
  provider: TileProvider;
  z: number;
  x: number;
  y: number;
  data: ArrayBuffer;
  type: string;
  /** Downloaded for offline use: evicted only after every browsed tile. */
  pinned?: boolean;
}

export interface CachedTile {
  blob: Blob;
  /** When the bytes were fetched (ms since epoch); 0 if unknown. */
  storedAt: number;
}

interface TileRecord {
  key: string;
  data: ArrayBuffer;
  type: string;
}

interface MetaRecord {
  key: string;
  provider: TileProvider;
  z: number;
  x: number;
  y: number;
  bytes: number;
  lastAccess: number;
  storedAt?: number;
  pinned?: boolean;
}

/** One zoom level of the footprint: how many of its tiles are cached. */
export interface ZoomCoverage {
  z: number;
  cached: number;
  total: number;
}

export interface TileCacheStats {
  bytes: number;
  tiles: number;
  /** The downloaded (pinned) part of the totals. */
  pinned: { bytes: number; tiles: number };
  perProvider: Partial<Record<TileProvider, { bytes: number; tiles: number }>>;
}

/** One database per stack, like the app's DuckDB file: dev and prod never share tiles. */
export function tileCacheDbName(stack: string | null): string {
  return `adsb-tile-cache-${stack || "default"}`;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("tile cache transaction aborted"));
  });
}

/** Visit every record under a cursor; `visit` may call `cursor.delete()`. */
function eachCursor(
  r: IDBRequest<IDBCursorWithValue | null>,
  visit: (cursor: IDBCursorWithValue) => boolean | void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const cursor = r.result;
      if (!cursor) return resolve();
      if (visit(cursor) === false) return resolve();
      cursor.continue();
    };
  });
}

export class TileStore {
  // A monotonic clock, so two accesses in the same millisecond still order.
  private lastStamp = 0;
  private pendingAccess = new Map<string, number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(private readonly db: IDBDatabase) {}

  static async open(name: string): Promise<TileStore> {
    const r = indexedDB.open(name, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(TILES)) db.createObjectStore(TILES, { keyPath: "key" });
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "key" }).createIndex(BY_ACCESS, "lastAccess");
      }
    };
    return new TileStore(await req(r));
  }

  /** The IndexedDB database name -- per stack, see `tileCacheDbName`. */
  get name(): string {
    return this.db.name;
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.db.close();
  }

  private stamp(): number {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return this.lastStamp;
  }

  /** The tile and when it was stored, marking it most recently used; undefined on a miss. */
  async get(key: string): Promise<CachedTile | undefined> {
    const tx = this.db.transaction([TILES, META], "readonly");
    const [record, meta] = await Promise.all([
      req(tx.objectStore(TILES).get(key)) as Promise<TileRecord | undefined>,
      req(tx.objectStore(META).get(key)) as Promise<MetaRecord | undefined>,
    ]);
    if (!record) return undefined;
    this.pendingAccess.set(key, this.stamp());
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      void this.flushAccess().catch(() => {});
    }, ACCESS_FLUSH_MS);
    return { blob: new Blob([record.data], { type: record.type }), storedAt: meta?.storedAt ?? 0 };
  }

  /** Write the access times of recent reads, in one transaction. */
  async flushAccess(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pendingAccess.size === 0) return;
    const pending = this.pendingAccess;
    this.pendingAccess = new Map();
    const tx = this.db.transaction(META, "readwrite");
    const metas = tx.objectStore(META);
    for (const [key, lastAccess] of pending) {
      const r = metas.get(key);
      r.onsuccess = () => {
        const m = r.result as MetaRecord | undefined;
        // Evicted meanwhile: nothing to touch. Never resurrect a deleted tile.
        if (m && m.lastAccess < lastAccess) metas.put({ ...m, lastAccess });
      };
    }
    await done(tx);
  }

  /** If the tile is cached, mark it downloaded (pinned) and return true. */
  async pinIfCached(key: string): Promise<boolean> {
    const tx = this.db.transaction(META, "readwrite");
    const metas = tx.objectStore(META);
    const meta = (await req(metas.get(key))) as MetaRecord | undefined;
    if (meta && !meta.pinned) metas.put({ ...meta, pinned: true });
    await done(tx);
    return meta !== undefined;
  }

  async has(key: string): Promise<boolean> {
    const tx = this.db.transaction(META, "readonly");
    const n = await req(tx.objectStore(META).count(key));
    return n > 0;
  }

  async put(tile: TilePut): Promise<void> {
    const tx = this.db.transaction([TILES, META], "readwrite");
    const metas = tx.objectStore(META);
    const previous = (await req(metas.get(tile.key))) as MetaRecord | undefined;
    const record: TileRecord = { key: tile.key, data: tile.data, type: tile.type };
    const now = this.stamp();
    const meta: MetaRecord = {
      key: tile.key,
      provider: tile.provider,
      z: tile.z,
      x: tile.x,
      y: tile.y,
      bytes: tile.data.byteLength,
      lastAccess: now,
      storedAt: Date.now(),
      // A refresh of a downloaded tile stays downloaded.
      pinned: Boolean(tile.pinned || previous?.pinned),
    };
    tx.objectStore(TILES).put(record);
    metas.put(meta);
    await done(tx);
  }

  async stats(): Promise<TileCacheStats> {
    const out: TileCacheStats = { bytes: 0, tiles: 0, pinned: { bytes: 0, tiles: 0 }, perProvider: {} };
    const tx = this.db.transaction(META, "readonly");
    await eachCursor(tx.objectStore(META).openCursor(), (c) => {
      const m = c.value as MetaRecord;
      out.bytes += m.bytes;
      out.tiles += 1;
      if (m.pinned) {
        out.pinned.bytes += m.bytes;
        out.pinned.tiles += 1;
      }
      const p = (out.perProvider[m.provider] ??= { bytes: 0, tiles: 0 });
      p.bytes += m.bytes;
      p.tiles += 1;
    });
    return out;
  }

  /**
   * Delete least-recently-used tiles until the total is at most `maxBytes`:
   * browsed tiles first, downloaded (pinned) ones only if that is not enough.
   * Returns how many went.
   */
  async evictTo(maxBytes: number): Promise<number> {
    await this.flushAccess();
    const { bytes } = await this.stats();
    if (bytes <= maxBytes) return 0;
    let excess = bytes - maxBytes;
    let removed = 0;
    const tx = this.db.transaction([TILES, META], "readwrite");
    const tiles = tx.objectStore(TILES);
    const byAccess = tx.objectStore(META).index(BY_ACCESS);
    for (const pass of [false, true]) {
      if (excess <= 0) break;
      await eachCursor(byAccess.openCursor(), (c) => {
        if (excess <= 0) return false;
        const m = c.value as MetaRecord;
        if (Boolean(m.pinned) !== pass) return;
        tiles.delete(m.key);
        c.delete();
        excess -= m.bytes;
        removed += 1;
      });
    }
    await done(tx);
    return removed;
  }

  /** Delete every tile that no longer touches the footprint. Returns how many went. */
  async pruneOutside(lat: number, lon: number, radiusNm: number): Promise<number> {
    let removed = 0;
    const tx = this.db.transaction([TILES, META], "readwrite");
    const tiles = tx.objectStore(TILES);
    await eachCursor(tx.objectStore(META).openCursor(), (c) => {
      const m = c.value as MetaRecord;
      if (!tileIntersectsCircle(m.z, m.x, m.y, lat, lon, radiusNm)) {
        tiles.delete(m.key);
        c.delete();
        removed += 1;
      }
    });
    await done(tx);
    return removed;
  }

  /**
   * How ready the footprint is for offline use, zoom by zoom, for one
   * provider and pixel density (retina keys are separate tiles).
   */
  async coverage(
    provider: TileProvider,
    retina: boolean,
    lat: number,
    lon: number,
    radiusNm: number,
    maxZoom: number,
  ): Promise<ZoomCoverage[]> {
    const out: ZoomCoverage[] = Array.from({ length: maxZoom + 1 }, (_, z) => ({ z, cached: 0, total: 0 }));
    for (const t of tilesInRadius(lat, lon, radiusNm, maxZoom)) out[t.z].total += 1;
    const tx = this.db.transaction(META, "readonly");
    await eachCursor(tx.objectStore(META).openCursor(), (c) => {
      const m = c.value as MetaRecord;
      if (m.provider !== provider || m.z > maxZoom || m.key.endsWith("@2x") !== retina) return;
      if (tileIntersectsCircle(m.z, m.x, m.y, lat, lon, radiusNm)) out[m.z].cached += 1;
    });
    return out;
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction([TILES, META], "readwrite");
    tx.objectStore(TILES).clear();
    tx.objectStore(META).clear();
    await done(tx);
  }
}

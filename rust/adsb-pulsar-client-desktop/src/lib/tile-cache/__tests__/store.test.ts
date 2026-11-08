import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lonLatToTile, tilesInRadius } from "../geometry";
import type { TileProvider } from "../keys";
import { TileStore, tileCacheDbName } from "../store";

const RX = { lat: 45.5, lon: -73.6 };

function bytes(n: number): ArrayBuffer {
  return new Uint8Array(n).fill(7).buffer;
}

let store: TileStore;
let dbSeq = 0;

beforeEach(async () => {
  store = await TileStore.open(`test-tiles-${dbSeq++}`);
});

afterEach(() => {
  store.close();
});

async function putTile(
  z: number,
  x: number,
  y: number,
  size: number,
  provider: TileProvider = "esri-dark",
  pinned = false,
) {
  await store.put({ key: `${provider}/${z}/${x}/${y}`, provider, z, x, y, data: bytes(size), type: "image/jpeg", pinned });
}

describe("tileCacheDbName", () => {
  it("keys the database by stack, the unnamed stack being 'default'", () => {
    expect(tileCacheDbName("prod")).toBe("adsb-tile-cache-prod");
    expect(tileCacheDbName(null)).toBe("adsb-tile-cache-default");
  });
});

describe("TileStore", () => {
  it("round-trips a tile as a Blob with its content type and when it was stored", async () => {
    const before = Date.now();
    await putTile(3, 1, 2, 100);
    const hit = await store.get("esri-dark/3/1/2");
    expect(hit?.blob.size).toBe(100);
    expect(hit?.blob.type).toBe("image/jpeg");
    expect(hit?.storedAt).toBeGreaterThanOrEqual(before);
    expect(await store.has("esri-dark/3/1/2")).toBe(true);
    expect(await store.get("esri-dark/9/9/9")).toBeUndefined();
  });

  it("reports total bytes, tile count and a per-provider breakdown", async () => {
    await putTile(3, 1, 2, 100);
    await putTile(3, 1, 3, 50);
    await putTile(3, 1, 2, 30, "carto-dark");
    expect(await store.stats()).toEqual({
      bytes: 180,
      tiles: 3,
      pinned: { bytes: 0, tiles: 0 },
      perProvider: {
        "esri-dark": { bytes: 150, tiles: 2 },
        "carto-dark": { bytes: 30, tiles: 1 },
      },
    });
  });

  it("replacing a tile does not double-count it", async () => {
    await putTile(3, 1, 2, 100);
    await putTile(3, 1, 2, 40);
    expect((await store.stats()).bytes).toBe(40);
  });

  it("evicts least-recently-used tiles first until under the cap", async () => {
    await putTile(5, 0, 0, 100); // oldest
    await putTile(5, 0, 1, 100);
    await putTile(5, 0, 2, 100);
    // Reading the oldest makes it the most recent.
    await store.get("esri-dark/5/0/0");
    const removed = await store.evictTo(200);
    expect(removed).toBe(1);
    expect(await store.has("esri-dark/5/0/0")).toBe(true);
    expect(await store.has("esri-dark/5/0/1")).toBe(false);
    expect(await store.has("esri-dark/5/0/2")).toBe(true);
  });

  it("evictTo is a no-op under the cap", async () => {
    await putTile(5, 0, 0, 100);
    expect(await store.evictTo(1000)).toBe(0);
    expect((await store.stats()).tiles).toBe(1);
  });

  it("prunes tiles outside the footprint and keeps those inside", async () => {
    const near = lonLatToTile(RX.lat, RX.lon, 8);
    const far = lonLatToTile(-33.9, 151.2, 8); // Sydney
    await putTile(8, near.x, near.y, 10);
    await putTile(8, far.x, far.y, 10);
    expect(await store.pruneOutside(RX.lat, RX.lon, 500)).toBe(1);
    expect(await store.has(`esri-dark/8/${near.x}/${near.y}`)).toBe(true);
    expect(await store.has(`esri-dark/8/${far.x}/${far.y}`)).toBe(false);
  });

  it("clears everything", async () => {
    await putTile(5, 0, 0, 100);
    await store.clear();
    expect(await store.stats()).toEqual({ bytes: 0, tiles: 0, pinned: { bytes: 0, tiles: 0 }, perProvider: {} });
  });

  it("reads in read-only transactions and writes access times in one batch", async () => {
    // Read-write transactions on the same stores run one at a time; a screen of
    // cache hits must not queue behind each other just to bump lastAccess.
    for (let x = 0; x < 5; x++) await putTile(5, x, 0, 10);
    const db = (store as unknown as { db: IDBDatabase }).db;
    const spy = vi.spyOn(db, "transaction");
    await Promise.all([0, 1, 2, 3, 4].map((x) => store.get(`esri-dark/5/${x}/0`)));
    expect(spy.mock.calls.filter((c) => c[1] === "readwrite")).toHaveLength(0);
    await store.flushAccess();
    expect(spy.mock.calls.filter((c) => c[1] === "readwrite")).toHaveLength(1);
  });

  it("eviction sees reads not yet flushed", async () => {
    await putTile(5, 0, 0, 100);
    await putTile(5, 0, 1, 100);
    await store.get("esri-dark/5/0/0"); // pending, not flushed
    await store.evictTo(100);
    expect(await store.has("esri-dark/5/0/0")).toBe(true);
    expect(await store.has("esri-dark/5/0/1")).toBe(false);
  });

  it("evicts browsed tiles before downloaded (pinned) ones, whatever their age", async () => {
    await putTile(5, 0, 0, 100, "esri-dark", true); // downloaded, oldest
    await putTile(5, 0, 1, 100);
    await putTile(5, 0, 2, 100);
    expect(await store.evictTo(100)).toBe(2);
    expect(await store.has("esri-dark/5/0/0")).toBe(true);
  });

  it("evicts pinned tiles only when browsed ones are not enough to meet the cap", async () => {
    await putTile(5, 0, 0, 100, "esri-dark", true);
    await putTile(5, 0, 1, 100, "esri-dark", true);
    await putTile(5, 0, 2, 100);
    expect(await store.evictTo(100)).toBe(2);
    expect(await store.has("esri-dark/5/0/1")).toBe(true);
  });

  it("re-storing a pinned tile (a refresh) keeps the pin", async () => {
    await putTile(5, 0, 0, 100, "esri-dark", true);
    await putTile(5, 0, 0, 100); // e.g. read-through refresh
    await putTile(5, 0, 1, 100);
    await store.evictTo(100);
    expect(await store.has("esri-dark/5/0/0")).toBe(true);
  });

  it("pinIfCached pins a tile already there and reports a miss", async () => {
    await putTile(5, 0, 0, 100);
    await putTile(5, 0, 1, 100);
    expect(await store.pinIfCached("esri-dark/5/0/0")).toBe(true);
    expect(await store.pinIfCached("esri-dark/9/9/9")).toBe(false);
    await store.evictTo(100);
    expect(await store.has("esri-dark/5/0/0")).toBe(true);
  });

  it("stats count downloaded (pinned) tiles separately", async () => {
    await putTile(5, 0, 0, 100, "esri-dark", true);
    await putTile(5, 0, 1, 40);
    expect((await store.stats()).pinned).toEqual({ bytes: 100, tiles: 1 });
  });

  describe("coverage", () => {
    it("counts, per zoom, the footprint tiles cached against those needed", async () => {
      const needed = [...tilesInRadius(RX.lat, RX.lon, 100, 3)];
      // All of z0-z2, one tile of z3.
      for (const t of needed.filter((t) => t.z < 3)) await putTile(t.z, t.x, t.y, 1);
      const z3 = needed.find((t) => t.z === 3)!;
      await putTile(3, z3.x, z3.y, 1);
      const cov = await store.coverage("esri-dark", false, RX.lat, RX.lon, 100, 3);
      expect(cov.map((c) => c.z)).toEqual([0, 1, 2, 3]);
      for (const c of cov.slice(0, 3)) expect(c.cached).toBe(c.total);
      expect(cov[3]).toEqual({ z: 3, cached: 1, total: needed.filter((t) => t.z === 3).length });
    });

    it("ignores other providers, the other pixel density, tiles outside the footprint and deeper zooms", async () => {
      const near = lonLatToTile(RX.lat, RX.lon, 2);
      const far = lonLatToTile(-33.9, 151.2, 2);
      await putTile(2, near.x, near.y, 1, "carto-dark");
      await store.put({ key: `esri-dark/2/${near.x}/${near.y}@2x`, provider: "esri-dark", z: 2, x: near.x, y: near.y, data: bytes(1), type: "image/png" });
      await putTile(2, far.x, far.y, 1);
      await putTile(5, 0, 0, 1);
      const cov = await store.coverage("esri-dark", false, RX.lat, RX.lon, 100, 2);
      expect(cov.every((c) => c.cached === 0)).toBe(true);
    });
  });
});

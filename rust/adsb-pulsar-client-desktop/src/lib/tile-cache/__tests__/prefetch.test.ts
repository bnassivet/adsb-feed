import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateTiles } from "../geometry";
import { PrefetchRefusedError, prefetchArea, type PrefetchProgress } from "../prefetch";
import { TileStore } from "../store";
import { sha256Hex } from "../validate";

const RX = { lat: 45.5, lon: -73.6 };
const ESRI = {
  provider: "esri-dark" as const,
  url: "https://h/tile/{z}/{y}/{x}",
  maxZoom: 16,
};

function okFetch(size = 10) {
  return vi.fn(async () => new Response(new Uint8Array(size), { status: 200, headers: { "content-type": "image/jpeg" } }));
}

let store: TileStore;
let seq = 0;
beforeEach(async () => {
  store = await TileStore.open(`prefetch-${seq++}`);
});
afterEach(() => store.close());

function opts(overrides: Partial<Parameters<typeof prefetchArea>[0]> = {}) {
  return {
    store,
    tile: ESRI,
    lat: RX.lat,
    lon: RX.lon,
    radiusNm: 100,
    maxZoom: 6,
    retina: false,
    maxBytes: 1e9,
    fetchFn: okFetch(),
    ...overrides,
  };
}

describe("prefetchArea", () => {
  it("fetches every tile in the footprint and reports progress to completion", async () => {
    const expected = estimateTiles(RX.lat, RX.lon, 100, 6).count;
    const seen: PrefetchProgress[] = [];
    const result = await prefetchArea(opts({ onProgress: (p) => seen.push(p) }));
    expect(result).toMatchObject({ total: expected, done: expected, fetched: expected, failed: 0, status: "complete" });
    expect((await store.stats()).tiles).toBe(expected);
    expect(seen.at(-1)?.done).toBe(expected);
    // The total is known before the first tile lands, so the UI can show it at once.
    expect(seen[0]).toMatchObject({ total: expected, done: 0, status: "running" });
  });

  it("fills Esri's row-before-column URL", async () => {
    const fetchFn = okFetch();
    await prefetchArea(opts({ maxZoom: 0, fetchFn }));
    expect(fetchFn).toHaveBeenCalledWith("https://h/tile/0/0/0", expect.objectContaining({ mode: "cors" }));
  });

  it("skips tiles already cached", async () => {
    await prefetchArea(opts());
    const fetchFn = okFetch();
    const result = await prefetchArea(opts({ fetchFn }));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.fetched).toBe(0);
    expect(result.done).toBe(result.total);
  });

  it("refuses OpenStreetMap, whose tile policy forbids bulk download", async () => {
    await expect(
      prefetchArea(opts({ tile: { provider: "osm", url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19 } })),
    ).rejects.toBeInstanceOf(PrefetchRefusedError);
  });

  it("never goes deeper than the provider serves", async () => {
    const fetchFn = okFetch();
    await prefetchArea(opts({ tile: { ...ESRI, maxZoom: 2 }, maxZoom: 6, fetchFn }));
    const zooms = fetchFn.mock.calls.map((c) => Number(/\/tile\/(\d+)\//.exec((c as unknown as [string])[0])?.[1]));
    expect(Math.max(...zooms)).toBe(2);
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => {
      controller.abort();
      return new Response(new Uint8Array(10), { status: 200, headers: { "content-type": "image/png" } });
    });
    const result = await prefetchArea(opts({ signal: controller.signal, fetchFn, concurrency: 1 }));
    expect(result.status).toBe("cancelled");
    expect(result.done).toBeLessThan(result.total);
  });

  it("stops at the size cap instead of evicting what it just downloaded", async () => {
    const result = await prefetchArea(opts({ fetchFn: okFetch(1000), maxBytes: 5000, concurrency: 1 }));
    expect(result.status).toBe("cap-reached");
    expect((await store.stats()).bytes).toBeLessThanOrEqual(5000);
  });

  it("counts failed tiles and carries on", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () =>
      n++ === 0 ? new Response("", { status: 500 }) : new Response(new Uint8Array(10), { status: 200, headers: { "content-type": "image/png" } }),
    );
    const result = await prefetchArea(opts({ maxZoom: 3, fetchFn, concurrency: 1 }));
    expect(result.failed).toBe(1);
    expect(result.status).toBe("complete");
    expect(result.fetched).toBe(result.total - 1);
  });

  it("counts a non-image response as failed and stores nothing for it", async () => {
    const fetchFn = vi.fn(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    const result = await prefetchArea(opts({ maxZoom: 1, fetchFn }));
    expect(result.failed).toBe(result.total);
    expect((await store.stats()).tiles).toBe(0);
  });

  it("stops at the first provider placeholder: every other tile would be the same bad image", async () => {
    const data = new Uint8Array([5, 4, 3, 2]);
    const placeholders = [{ name: "test", bytes: 4, sha256: await sha256Hex(data.buffer) }];
    const fetchFn = vi.fn(async () => new Response(data, { status: 200, headers: { "content-type": "image/png" } }));
    const result = await prefetchArea(opts({ fetchFn, placeholders, concurrency: 1 }));
    expect(result.status).toBe("placeholder");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await store.stats()).tiles).toBe(0);
  });

  it("pins what it downloads AND what was already cached, so browsing never evicts the area", async () => {
    await prefetchArea(opts({ maxZoom: 1 }));
    const browsed = await TileStore.open(`prefetch-${seq++}`);
    try {
      // One tile cached by browsing before the download ran.
      await browsed.put({ key: "esri-dark/0/0/0", provider: "esri-dark", z: 0, x: 0, y: 0, data: new ArrayBuffer(10), type: "image/png" });
      const fetchFn = okFetch();
      const result = await prefetchArea(opts({ store: browsed, maxZoom: 1, fetchFn }));
      const stats = await browsed.stats();
      expect(stats.pinned.tiles).toBe(result.total);
      expect(fetchFn).toHaveBeenCalledTimes(result.total - 1);
    } finally {
      browsed.close();
    }
  });

  it("stops when storage is full instead of fetching tiles it cannot keep", async () => {
    vi.spyOn(store, "put").mockRejectedValue(new DOMException("full", "QuotaExceededError"));
    const fetchFn = okFetch();
    const onStoreError = vi.fn();
    const result = await prefetchArea(opts({ fetchFn, concurrency: 1, onStoreError }));
    expect(result.status).toBe("storage-full");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onStoreError).toHaveBeenCalledTimes(1);
  });

  it("counts any other write failure as failed and carries on", async () => {
    vi.spyOn(store, "put").mockRejectedValueOnce(new Error("hiccup"));
    const result = await prefetchArea(opts({ maxZoom: 1, concurrency: 1 }));
    expect(result.failed).toBe(1);
    expect(result.status).toBe("complete");
  });
});

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lonLatToTile } from "../geometry";
import { loadTile, REFRESH_AFTER_MS } from "../loadTile";
import { TileStore } from "../store";
import { sha256Hex } from "../validate";

const RX = { lat: 45.5, lon: -73.6 };
const NEAR = { z: 8, ...lonLatToTile(RX.lat, RX.lon, 8) };
const FAR = { z: 8, ...lonLatToTile(-33.9, 151.2, 8) };

function okFetch(size = 64, type = "image/png") {
  return vi.fn(async () => new Response(new Uint8Array(size), { status: 200, headers: { "content-type": type } }));
}

let store: TileStore;
let seq = 0;
beforeEach(async () => {
  store = await TileStore.open(`load-tile-${seq++}`);
});
afterEach(() => store.close());

function base(coord: { z: number; x: number; y: number }, fetchFn: typeof fetch) {
  return {
    key: `esri-dark/${coord.z}/${coord.x}/${coord.y}`,
    provider: "esri-dark" as const,
    coord,
    url: "https://tiles.example/t.png",
    store,
    enabled: true,
    footprint: { lat: RX.lat, lon: RX.lon, radiusNm: 500 },
    fetchFn,
  };
}

describe("loadTile", () => {
  it("fetches a miss, returns it, and stores it when inside the footprint", async () => {
    const fetchFn = okFetch(64);
    const onStored = vi.fn();
    const blob = await loadTile({ ...base(NEAR, fetchFn), onStored });
    expect(blob.size).toBe(64);
    expect(blob.type).toBe("image/png");
    expect(fetchFn).toHaveBeenCalledWith("https://tiles.example/t.png", { mode: "cors" });
    expect(await store.has(base(NEAR, fetchFn).key)).toBe(true);
    expect(onStored).toHaveBeenCalledTimes(1);
  });

  it("serves a hit from the store without touching the network", async () => {
    await loadTile(base(NEAR, okFetch(64)));
    const fetchFn = okFetch();
    const blob = await loadTile(base(NEAR, fetchFn));
    expect(blob.size).toBe(64);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not store a tile outside the footprint", async () => {
    await loadTile(base(FAR, okFetch()));
    expect((await store.stats()).tiles).toBe(0);
  });

  it("does not store anything without a receiver location", async () => {
    await loadTile({ ...base(NEAR, okFetch()), footprint: null });
    expect((await store.stats()).tiles).toBe(0);
  });

  it("still serves cached tiles when storing is disabled", async () => {
    await loadTile(base(NEAR, okFetch(64)));
    const fetchFn = okFetch();
    const blob = await loadTile({ ...base(NEAR, fetchFn), enabled: false });
    expect(blob.size).toBe(64);
    expect(fetchFn).not.toHaveBeenCalled();
    // ...but a new tile is not added.
    await loadTile({ ...base({ ...NEAR, x: NEAR.x + 1 }, okFetch()), enabled: false });
    expect((await store.stats()).tiles).toBe(1);
  });

  it("works with no store at all (IndexedDB unavailable)", async () => {
    const blob = await loadTile({ ...base(NEAR, okFetch(10)), store: null });
    expect(blob.size).toBe(10);
  });

  it("rejects on an HTTP error so the layer can fall back", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(loadTile(base(NEAR, fetchFn))).rejects.toThrow("404");
    expect((await store.stats()).tiles).toBe(0);
  });

  it("returns the tile even if storing it fails (quota), and reports the failure", async () => {
    const full = new DOMException("full", "QuotaExceededError");
    vi.spyOn(store, "put").mockRejectedValueOnce(full);
    const onStoreError = vi.fn();
    const blob = await loadTile({ ...base(NEAR, okFetch(32)), onStoreError });
    expect(blob.size).toBe(32);
    expect(onStoreError).toHaveBeenCalledWith(full);
  });

  it("does not store a non-image body served as 200 (captive portal, proxy page)", async () => {
    const fetchFn = okFetch(64, "text/html");
    await expect(loadTile(base(NEAR, fetchFn))).rejects.toThrow("not an image");
    expect((await store.stats()).tiles).toBe(0);
  });

  it("shows a provider placeholder (bad API key) but never stores it", async () => {
    const data = new Uint8Array([5, 4, 3, 2]);
    const placeholders = [{ name: "test", bytes: 4, sha256: await sha256Hex(data.buffer) }];
    const fetchFn = vi.fn(async () => new Response(data, { status: 200, headers: { "content-type": "image/png" } }));
    const blob = await loadTile({ ...base(NEAR, fetchFn), placeholders });
    expect(blob.size).toBe(4);
    expect((await store.stats()).tiles).toBe(0);
  });

  describe("refresh when online (stale-while-revalidate)", () => {
    const later = () => Date.now() + REFRESH_AFTER_MS + 60_000;
    const online = () => true;

    it("serves a stale tile at once and refreshes it in the background", async () => {
      await loadTile(base(NEAR, okFetch(64)));
      const fetchFn = okFetch(80);
      const onStored = vi.fn();
      const blob = await loadTile({ ...base(NEAR, fetchFn), now: later, isOnline: online, onStored });
      expect(blob.size).toBe(64); // the cached copy, not the refresh
      await vi.waitFor(() => expect(onStored).toHaveBeenCalled());
      expect((await store.get(base(NEAR, fetchFn).key))?.blob.size).toBe(80);
    });

    it("refreshes even with storing disabled or no receiver: it replaces, it does not add", async () => {
      await loadTile(base(NEAR, okFetch(64)));
      const onStored = vi.fn();
      await loadTile({ ...base(NEAR, okFetch(80)), enabled: false, footprint: null, now: later, isOnline: online, onStored });
      await vi.waitFor(() => expect(onStored).toHaveBeenCalled());
    });

    it("does not refetch a fresh tile", async () => {
      await loadTile(base(NEAR, okFetch(64)));
      const fetchFn = okFetch();
      await loadTile({ ...base(NEAR, fetchFn), isOnline: online });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("never tries while offline, and never deletes a tile for its age", async () => {
      await loadTile(base(NEAR, okFetch(64)));
      const fetchFn = okFetch();
      const blob = await loadTile({ ...base(NEAR, fetchFn), now: later, isOnline: () => false });
      expect(blob.size).toBe(64);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("keeps the old tile when the refresh fails or returns a placeholder", async () => {
      await loadTile(base(NEAR, okFetch(64)));
      const failing = vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      });
      await loadTile({ ...base(NEAR, failing), now: later, isOnline: online });
      await vi.waitFor(() => expect(failing).toHaveBeenCalled());
      const data = new Uint8Array([5, 4, 3, 2]);
      const placeholders = [{ name: "test", bytes: 4, sha256: await sha256Hex(data.buffer) }];
      const bad = vi.fn(async () => new Response(data, { status: 200, headers: { "content-type": "image/png" } }));
      await loadTile({ ...base(NEAR, bad), now: later, isOnline: online, placeholders });
      await vi.waitFor(() => expect(bad).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect((await store.get(base(NEAR, bad).key))?.blob.size).toBe(64);
    });
  });
});

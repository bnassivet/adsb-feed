import "fake-indexeddb/auto";
import L from "leaflet";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lonLatToTile } from "../geometry";
import { createCachedTileLayer, type CacheContext } from "../CachedTileLayer";
import { TileStore } from "../store";

const RX = { lat: 45.5, lon: -73.6 };
const ESRI = {
  provider: "esri-dark" as const,
  url: "https://h/tile/{z}/{y}/{x}",
  attribution: "",
  maxZoom: 16,
};

let store: TileStore;
let seq = 0;
let fetchFn: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  store = await TileStore.open(`layer-${seq++}`);
  fetchFn = vi.fn(async () => new Response(new Uint8Array(20), { status: 200, headers: { "content-type": "image/jpeg" } }));
  vi.stubGlobal("fetch", fetchFn);
  URL.createObjectURL = vi.fn(() => "blob:tile");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  store.close();
  vi.unstubAllGlobals();
});

function ctx(overrides: Partial<CacheContext> = {}): () => CacheContext {
  return () => ({
    store: Promise.resolve(store),
    enabled: true,
    footprint: { lat: RX.lat, lon: RX.lon, radiusNm: 500 },
    ...overrides,
  });
}

function createTile(layer: L.TileLayer, coord: { z: number; x: number; y: number }) {
  const point = Object.assign(L.point(coord.x, coord.y), { z: coord.z }) as L.Coords;
  const done = vi.fn();
  const el = (layer as unknown as { createTile(c: L.Coords, d: L.DoneCallback): HTMLImageElement }).createTile(
    point,
    done,
  );
  return { el, done };
}

describe("createCachedTileLayer", () => {
  it("loads the tile through the cache and shows it as a blob URL", async () => {
    const near = { z: 8, ...lonLatToTile(RX.lat, RX.lon, 8) };
    const { el } = createTile(createCachedTileLayer(ESRI, ctx()), near);
    await vi.waitFor(() => expect(el.src).toBe("blob:tile"));
    expect(fetchFn).toHaveBeenCalledWith(`https://h/tile/8/${near.y}/${near.x}`, { mode: "cors" });
    expect(await store.has(`esri-dark/8/${near.x}/${near.y}`)).toBe(true);
  });

  it("falls back to the direct URL when the fetch fails, so Leaflet shows its error tile", async () => {
    fetchFn.mockRejectedValueOnce(new TypeError("offline"));
    const { el } = createTile(createCachedTileLayer(ESRI, ctx()), { z: 3, x: 1, y: 2 });
    await vi.waitFor(() => expect(el.src).toBe("https://h/tile/3/2/1"));
  });

  it("reports a tile it could not store", async () => {
    const full = new DOMException("full", "QuotaExceededError");
    vi.spyOn(store, "put").mockRejectedValueOnce(full);
    const onStoreError = vi.fn();
    const near = { z: 8, ...lonLatToTile(RX.lat, RX.lon, 8) };
    const { el } = createTile(createCachedTileLayer(ESRI, ctx({ onStoreError })), near);
    await vi.waitFor(() => expect(el.src).toBe("blob:tile"));
    expect(onStoreError).toHaveBeenCalledWith(full);
  });

  describe("offline past the downloaded zoom", () => {
    it("draws the tile from its nearest cached ancestor, scaled up", async () => {
      await store.put({ key: "esri-dark/4/0/1", provider: "esri-dark", z: 4, x: 0, y: 1, data: new ArrayBuffer(33), type: "image/jpeg" });
      fetchFn.mockRejectedValue(new TypeError("offline"));
      const renderCrop = vi.fn(async () => new Blob(["scaled"]));
      const layer = createCachedTileLayer(ESRI, ctx(), { renderCrop });
      const { el } = createTile(layer, { z: 6, x: 1, y: 6 });
      await vi.waitFor(() => expect(el.src).toBe("blob:tile"));
      expect(renderCrop).toHaveBeenCalledWith(
        expect.objectContaining({ size: 33 }),
        { ancestor: { z: 4, x: 0, y: 1 }, fx: 0.25, fy: 0.5, fsize: 0.25 },
        256,
      );
    });

    it("falls back to the plain URL when no ancestor is cached either", async () => {
      fetchFn.mockRejectedValue(new TypeError("offline"));
      const renderCrop = vi.fn();
      const { el } = createTile(createCachedTileLayer(ESRI, ctx(), { renderCrop }), { z: 6, x: 1, y: 6 });
      await vi.waitFor(() => expect(el.src).toBe("https://h/tile/6/6/1"));
      expect(renderCrop).not.toHaveBeenCalled();
    });

    it("falls back to the plain URL when drawing fails", async () => {
      await store.put({ key: "esri-dark/5/0/3", provider: "esri-dark", z: 5, x: 0, y: 3, data: new ArrayBuffer(5), type: "image/jpeg" });
      fetchFn.mockRejectedValue(new TypeError("offline"));
      const renderCrop = vi.fn(async () => {
        throw new Error("no canvas");
      });
      const { el } = createTile(createCachedTileLayer(ESRI, ctx(), { renderCrop }), { z: 6, x: 1, y: 6 });
      await vi.waitFor(() => expect(el.src).toBe("https://h/tile/6/6/1"));
    });
  });

  it("reads the context at tile time, so a settings change applies without a rebuild", async () => {
    let enabled = false;
    const layer = createCachedTileLayer(ESRI, () => ({ ...ctx()(), enabled }));
    const near = { z: 8, ...lonLatToTile(RX.lat, RX.lon, 8) };
    const first = createTile(layer, near);
    await vi.waitFor(() => expect(first.el.src).toBe("blob:tile"));
    expect((await store.stats()).tiles).toBe(0);
    enabled = true;
    const second = createTile(layer, { ...near, x: near.x + 1 });
    await vi.waitFor(() => expect(second.el.src).toBe("blob:tile"));
    expect((await store.stats()).tiles).toBe(1);
  });

  it("carries the provider's attribution and zoom cap, which the plain TileLayer used to", () => {
    const layer = createCachedTileLayer({ ...ESRI, attribution: "Tiles &copy; Esri" }, ctx());
    expect(layer.getAttribution?.()).toBe("Tiles &copy; Esri");
    expect(layer.options.maxZoom).toBe(16);
  });

  it("revokes the blob URL once the image has loaded", async () => {
    const { el, done } = createTile(createCachedTileLayer(ESRI, ctx()), { z: 3, x: 1, y: 2 });
    await vi.waitFor(() => expect(el.src).toBe("blob:tile"));
    el.dispatchEvent(new Event("load"));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:tile");
    expect(done).toHaveBeenCalledWith(undefined, el);
  });
});

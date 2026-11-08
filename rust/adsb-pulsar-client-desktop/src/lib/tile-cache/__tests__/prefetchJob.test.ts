import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPrefetchJob,
  prefetchJob,
  resetPrefetchJob,
  startPrefetchJob,
  subscribePrefetchJob,
} from "../prefetchJob";
import { TileStore } from "../store";

const ESRI = { provider: "esri-dark" as const, url: "https://h/tile/{z}/{y}/{x}", maxZoom: 16 };

let store: TileStore;
let seq = 0;
beforeEach(async () => {
  store = await TileStore.open(`job-${seq++}`);
});
afterEach(() => {
  resetPrefetchJob();
  store.close();
});

function okFetch() {
  return vi.fn(async () => new Response(new Uint8Array(10), { status: 200, headers: { "content-type": "image/png" } }));
}

function opts(overrides = {}) {
  return {
    store,
    tile: ESRI,
    lat: 45.5,
    lon: -73.6,
    radiusNm: 100,
    maxZoom: 2,
    retina: false,
    maxBytes: 1e9,
    fetchFn: okFetch(),
    ...overrides,
  };
}

describe("prefetch job", () => {
  it("is idle until started", () => {
    expect(prefetchJob()).toBeNull();
  });

  it("runs, publishes progress, and keeps the result after it ends", async () => {
    const listener = vi.fn();
    subscribePrefetchJob(listener);
    const result = await startPrefetchJob(opts());
    expect(result.status).toBe("complete");
    expect(listener).toHaveBeenCalled();
    expect(prefetchJob()).toMatchObject({ provider: "esri-dark", running: false, progress: result });
  });

  it("refuses a second run while one is going", async () => {
    const first = startPrefetchJob(opts());
    await expect(startPrefetchJob(opts())).rejects.toThrow(/already running/);
    await first;
  });

  it("can be cancelled from anywhere", async () => {
    // Like real fetch: an already-aborted signal rejects at once.
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const abort = () => reject(new DOMException("x", "AbortError"));
          if (init?.signal?.aborted) return abort();
          init?.signal?.addEventListener("abort", abort);
        }),
    );
    const run = startPrefetchJob(opts({ fetchFn }));
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
    cancelPrefetchJob();
    expect((await run).status).toBe("cancelled");
    expect(prefetchJob()?.running).toBe(false);
  });

  it("records a refusal as the job's error", async () => {
    await expect(
      startPrefetchJob(opts({ tile: { provider: "osm", url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19 } })),
    ).rejects.toThrow();
    expect(prefetchJob()).toMatchObject({ running: false, error: expect.stringMatching(/OpenStreetMap/) });
  });

  it("publishes a new snapshot on every change (useSyncExternalStore)", async () => {
    const seen = new Set<unknown>();
    subscribePrefetchJob(() => seen.add(prefetchJob()));
    await startPrefetchJob(opts());
    expect(seen.size).toBeGreaterThan(2);
  });
});

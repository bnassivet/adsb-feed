import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMockResponses, mockInvokeResponse } from "@/test/mocks/tauri";
import { resetSharedTileStore, sharedTileStore } from "../shared";

afterEach(() => {
  resetSharedTileStore();
  clearMockResponses();
});

describe("sharedTileStore", () => {
  it("opens the database named for this window's stack, once", async () => {
    mockInvokeResponse("get_stack", "prod");
    const a = await sharedTileStore();
    const b = await sharedTileStore();
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(a?.name).toBe("adsb-tile-cache-prod");
  });

  it("asks for persistent storage, so the webview is less inclined to evict the cache", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { ...navigator, storage: { persist } });
    await sharedTileStore();
    expect(persist).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("opens fine where the Storage API is missing", async () => {
    vi.stubGlobal("navigator", { ...navigator, storage: undefined });
    expect(await sharedTileStore()).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("uses the default database outside Tauri (get_stack fails)", async () => {
    const store = await sharedTileStore();
    expect(store?.name).toBe("adsb-tile-cache-default");
  });
});

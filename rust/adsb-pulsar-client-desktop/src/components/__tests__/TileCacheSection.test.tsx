import "fake-indexeddb/auto";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lonLatToTile } from "@/lib/tile-cache/geometry";
import { TILE_CACHE_SETTINGS_KEY } from "@/lib/tile-cache/settings";
import { recordStoreFailure, resetStoreHealth } from "@/lib/tile-cache/health";
import { resetPrefetchJob } from "@/lib/tile-cache/prefetchJob";
import { TileStore } from "@/lib/tile-cache/store";
import { TileCacheSection } from "../TileCacheSection";

const RX = { lat: 45.5, lon: -73.6 };
const MB = 1024 * 1024;

let store: TileStore;
let seq = 0;

beforeEach(async () => {
  localStorage.clear();
  store = await TileStore.open(`section-${seq++}`);
});

afterEach(() => {
  resetPrefetchJob();
  resetStoreHealth();
  store.close();
  vi.unstubAllGlobals();
});

async function seed(
  z: number,
  x: number,
  y: number,
  bytes: number,
  provider: "esri-dark" | "osm" = "esri-dark",
  pinned = false,
) {
  await store.put({ key: `${provider}/${z}/${x}/${y}`, provider, z, x, y, data: new ArrayBuffer(bytes), type: "image/png", pinned });
}

/**
 * A request that never answers, like a dead network -- until aborted. Like real
 * fetch, an already-aborted signal rejects at once: Cancel can land between a
 * worker's `aborted` check and its fetch, and a stub that only listens for the
 * event would then hang the run forever.
 */
function hangUntilAborted(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (init?.signal?.aborted) return abort();
    init?.signal?.addEventListener("abort", abort);
  });
}

const notFound = () => Promise.resolve({ path: null, searched: ["/w"] });

function renderSection(props: Partial<Parameters<typeof TileCacheSection>[0]> = {}) {
  return render(
    <TileCacheSection
      receiver={RX}
      openStore={() => Promise.resolve(store)}
      cartoApiKey={undefined}
      locate={notFound}
      {...props}
    />,
  );
}

describe("TileCacheSection", () => {
  it("shows the cache size against the cap, the tile count and a per-provider breakdown", async () => {
    await seed(5, 0, 0, 2 * MB);
    await seed(5, 0, 1, 1 * MB, "osm");
    renderSection();
    expect(await screen.findByText(/3\.00 MB of 500 MB/)).toBeInTheDocument();
    expect(screen.getByText(/\b2 tiles cached/)).toBeInTheDocument();
    expect(screen.getByText(/Esri Dark Gray: 2\.00 MB/)).toBeInTheDocument();
    expect(screen.getByText(/OpenStreetMap: 1\.00 MB/)).toBeInTheDocument();
  });

  it("shows how much of the cache was downloaded for offline use", async () => {
    await seed(5, 0, 0, 2 * MB, "esri-dark", true);
    await seed(5, 0, 1, 1 * MB);
    renderSection();
    expect(await screen.findByText(/Downloaded for offline use: 2\.00 MB · 1 tile\b/)).toBeInTheDocument();
  });

  it("shows how ready the footprint is for offline use, zoom by zoom", async () => {
    await seed(0, 0, 0, 10, "esri-dark", true);
    renderSection();
    expect(await screen.findByText(/Offline coverage \(Esri Dark Gray\): z0 complete · z1 0%/)).toBeInTheDocument();
  });

  it("does not show coverage without a receiver location", async () => {
    renderSection({ receiver: null });
    await screen.findByText(/of 500 MB/);
    expect(screen.queryByText(/Offline coverage/)).not.toBeInTheDocument();
  });

  it("shows the footprint defaults and an estimate for the prefetch", async () => {
    renderSection();
    expect(await screen.findByLabelText("Radius (NM)")).toHaveValue(500);
    expect(screen.getByLabelText("Max size (MB)")).toHaveValue(500);
    expect(screen.getByLabelText("Prefetch max zoom")).toHaveValue(10);
    expect(screen.getByText(/≈ [\d,]+ tiles/)).toBeInTheDocument();
  });

  it("rejects invalid settings without saving them", async () => {
    const user = userEvent.setup();
    renderSection();
    const radius = await screen.findByLabelText("Radius (NM)");
    await user.clear(radius);
    await user.type(radius, "5000");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/radius/i);
    expect(localStorage.getItem(TILE_CACHE_SETTINGS_KEY)).toBeNull();
  });

  it("applies a smaller footprint immediately, pruning tiles that fall outside it", async () => {
    const user = userEvent.setup();
    const near = lonLatToTile(RX.lat, RX.lon, 8);
    // ~250 NM east: inside 500 NM, outside 100 NM.
    const mid = lonLatToTile(RX.lat, RX.lon + 6, 8);
    await seed(8, near.x, near.y, 1000);
    await seed(8, mid.x, mid.y, 1000);
    renderSection();
    const radius = await screen.findByLabelText("Radius (NM)");
    await user.clear(radius);
    await user.type(radius, "100");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByText(/\b1 tile cached/)).toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem(TILE_CACHE_SETTINGS_KEY)!).radiusNm).toBe(100);
    expect(await store.has(`esri-dark/8/${mid.x}/${mid.y}`)).toBe(false);
  });

  it("clears the cache only after confirmation", async () => {
    const user = userEvent.setup();
    await seed(5, 0, 0, 1000);
    renderSection();
    await screen.findByText(/\b1 tile cached/);
    await user.click(screen.getByRole("button", { name: "Clear cache" }));
    expect((await store.stats()).tiles).toBe(1);
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));
    await waitFor(() => expect(screen.getByText(/\b0 tiles cached/)).toBeInTheDocument());
    expect((await store.stats()).tiles).toBe(0);
  });

  it("downloads the area with progress, then refreshes the stats", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(100), { status: 200, headers: { "content-type": "image/jpeg" } })),
    );
    renderSection();
    const zoom = await screen.findByLabelText("Prefetch max zoom");
    await user.clear(zoom);
    await user.type(zoom, "3");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await user.click(screen.getByRole("button", { name: "Download area" }));
    expect(await screen.findByText(/Download complete/)).toBeInTheDocument();
    const { tiles } = await store.stats();
    expect(tiles).toBeGreaterThan(0);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("can cancel a download", async () => {
    const user = userEvent.setup();
    // Never resolves until aborted.
    vi.stubGlobal(
      "fetch",
      vi.fn(hangUntilAborted),
    );
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Download area" }));
    await user.click(await screen.findByRole("button", { name: "Cancel download" }));
    expect(await screen.findByText(/Download cancelled/)).toBeInTheDocument();
  });

  it("keeps downloading after you leave Settings, and shows the result when you come back", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return new Response(new Uint8Array(100), { status: 200, headers: { "content-type": "image/jpeg" } });
      }),
    );
    const first = renderSection();
    const zoom = await screen.findByLabelText("Prefetch max zoom");
    await user.clear(zoom);
    await user.type(zoom, "1");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await user.click(screen.getByRole("button", { name: "Download area" }));
    expect(await screen.findByText(/leaving Settings does not stop it/)).toBeInTheDocument();
    first.unmount(); // navigate away
    release();
    await waitFor(async () => expect((await store.stats()).pinned.tiles).toBeGreaterThan(0));
    renderSection(); // come back
    expect(await screen.findByText(/Download complete/)).toBeInTheDocument();
  });

  it("shows a run already in progress when Settings opens, with Cancel", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(hangUntilAborted),
    );
    const first = renderSection();
    await user.click(await screen.findByRole("button", { name: "Download area" }));
    first.unmount();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Cancel download" }));
    expect(await screen.findByText(/Download cancelled/)).toBeInTheDocument();
  });

  it("disables Download area without a receiver location, and says why", async () => {
    renderSection({ receiver: null });
    expect(await screen.findByRole("button", { name: "Download area" })).toBeDisabled();
    expect(screen.getByText(/Set the receiver location/)).toBeInTheDocument();
  });

  it("offers only providers that allow bulk download — never OpenStreetMap", async () => {
    renderSection({ cartoApiKey: "k" });
    const select = await screen.findByLabelText("Download from");
    const options = [...(select as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(["esri-dark", "carto-dark"]);
  });

  it("reports tiles the map could not store, naming the last error", async () => {
    renderSection();
    await screen.findByText(/of 500 MB/);
    act(() => recordStoreFailure(new DOMException("over quota", "QuotaExceededError")));
    expect(await screen.findByText(/1 tile could not be stored/)).toBeInTheDocument();
    expect(screen.getByText(/QuotaExceededError/)).toBeInTheDocument();
  });

  it("warns when the size cap is more than the webview lets the app store", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      storage: { estimate: async () => ({ usage: 50 * MB, quota: 300 * MB }), persisted: async () => true },
    });
    renderSection();
    expect(await screen.findByText(/cap of 500 MB cannot be reached/)).toBeInTheDocument();
  });

  it("does not warn when the cap fits", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      storage: { estimate: async () => ({ usage: 50 * MB, quota: 10_000 * MB }), persisted: async () => true },
    });
    renderSection();
    await screen.findByText(/Webview storage/);
    expect(screen.queryByText(/cannot be reached/)).not.toBeInTheDocument();
  });

  it("flags a download that finished with failures: those tiles are not offline", async () => {
    const user = userEvent.setup();
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        n++ === 0
          ? new Response("", { status: 500 })
          : new Response(new Uint8Array(100), { status: 200, headers: { "content-type": "image/jpeg" } }),
      ),
    );
    renderSection();
    const zoom = await screen.findByLabelText("Prefetch max zoom");
    await user.clear(zoom);
    await user.type(zoom, "1");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await user.click(screen.getByRole("button", { name: "Download area" }));
    expect(await screen.findByText(/Download finished with 1 failed tile/)).toBeInTheDocument();
  });

  it("says when the cache is unavailable", async () => {
    renderSection({ openStore: () => Promise.resolve(null) });
    expect(await screen.findByText(/cache is unavailable/i)).toBeInTheDocument();
  });

  describe("location", () => {
    const PATH = "/Users/u/Library/WebKit/app/WebsiteData/Default/h/h/IndexedDB/8416E4";

    it("shows where the database is on disk, asking for this store's own name", async () => {
      const locate = vi.fn(async () => ({ path: PATH, searched: ["/w"] }));
      renderSection({ locate });
      expect(await screen.findByText(PATH)).toBeInTheDocument();
      expect(locate).toHaveBeenCalledWith(store.name);
      expect(screen.getByText(store.name)).toBeInTheDocument();
    });

    it("says the file does not exist yet before the first tile is stored", async () => {
      renderSection();
      expect(await screen.findByText(/Not on disk yet/)).toBeInTheDocument();
    });

    it("still names the database when the path cannot be looked up (outside Tauri)", async () => {
      renderSection({ locate: () => Promise.reject(new Error("no tauri")) });
      expect(await screen.findByText(store.name)).toBeInTheDocument();
      expect(screen.getByText(/Path unavailable/)).toBeInTheDocument();
    });

    it("copies the path", async () => {
      const user = userEvent.setup();
      renderSection({ locate: async () => ({ path: PATH, searched: [] }) });
      await user.click(await screen.findByRole("button", { name: "Copy path" }));
      expect(await navigator.clipboard.readText()).toBe(PATH);
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    });
  });
});

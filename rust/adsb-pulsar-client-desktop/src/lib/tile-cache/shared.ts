import { getStack } from "../commands";
import { TileStore, tileCacheDbName } from "./store";

let opening: Promise<TileStore | null> | null = null;

/**
 * The window's tile store, opened once and shared by the map and the Settings
 * page. Resolves null when IndexedDB is unavailable, in which case the map
 * simply loads tiles from the network.
 */
export function sharedTileStore(): Promise<TileStore | null> {
  opening ??= (async () => {
    // Best-effort: ask the webview not to evict this origin's storage under
    // pressure. Browsers may refuse or ignore it; the cache works either way.
    void navigator.storage?.persist?.().catch(() => false);
    let stack: string | null = null;
    try {
      stack = await getStack();
    } catch {
      // Not running under Tauri (plain `next dev` in a browser): default stack.
    }
    try {
      return await TileStore.open(tileCacheDbName(stack));
    } catch {
      return null;
    }
  })();
  return opening;
}

/** Tests only: forget the shared store so the next call reopens. */
export function resetSharedTileStore(): void {
  void opening?.then((s) => s?.close());
  opening = null;
}

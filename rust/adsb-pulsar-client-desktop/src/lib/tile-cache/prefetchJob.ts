import type { TileProvider } from "./keys";
import { prefetchArea, type PrefetchOptions, type PrefetchProgress } from "./prefetch";

/**
 * The window's one "Download area" run, owned outside React.
 *
 * Settings starts it and subscribes to it; leaving Settings unmounts the
 * component but not the run (navigation is client-side, the JS context lives
 * on), and returning shows its progress or result. Closing the app stops it.
 * Snapshots are replaced on every change, never mutated, as
 * `useSyncExternalStore` requires.
 */

export interface PrefetchJobState {
  provider: TileProvider;
  running: boolean;
  /** Null until the first report (the total is being counted). */
  progress: PrefetchProgress | null;
  /** Set when the run threw (e.g. a refused provider). */
  error?: string;
}

let state: PrefetchJobState | null = null;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();

function publish(next: PrefetchJobState | null): void {
  state = next;
  listeners.forEach((l) => l());
}

export function prefetchJob(): PrefetchJobState | null {
  return state;
}

export function subscribePrefetchJob(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function startPrefetchJob(
  opts: Omit<PrefetchOptions, "signal" | "onProgress">,
): Promise<PrefetchProgress> {
  if (state?.running) throw new Error("A download is already running.");
  const own = new AbortController();
  controller = own;
  const provider = opts.tile.provider;
  publish({ provider, running: true, progress: null });
  try {
    const result = await prefetchArea({
      ...opts,
      signal: own.signal,
      onProgress: (progress) => publish({ provider, running: true, progress }),
    });
    publish({ provider, running: false, progress: result });
    return result;
  } catch (e) {
    publish({ provider, running: false, progress: state?.progress ?? null, error: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    if (controller === own) controller = null;
  }
}

export function cancelPrefetchJob(): void {
  controller?.abort();
}

/** Tests only: stop any run and forget it. */
export function resetPrefetchJob(): void {
  controller?.abort();
  controller = null;
  state = null;
  listeners.clear();
}

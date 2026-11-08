/**
 * Tile writes that failed, across the window.
 *
 * Caching is best-effort, so a failed write never blanks the map -- but a
 * silent one means an area the user believes is offline-ready is not. The map
 * records failures here; Settings shows them. Shaped for `useSyncExternalStore`:
 * the snapshot is replaced (never mutated) on change.
 */

export interface StoreHealth {
  failures: number;
  last: { name: string; message: string; at: number } | null;
}

const CLEAN: StoreHealth = { failures: 0, last: null };
let health: StoreHealth = CLEAN;
const listeners = new Set<() => void>();

export function recordStoreFailure(error: unknown): void {
  const name = error instanceof Error || error instanceof DOMException ? error.name : "Error";
  const message = error instanceof Error || error instanceof DOMException ? error.message : String(error);
  health = { failures: health.failures + 1, last: { name, message, at: Date.now() } };
  listeners.forEach((l) => l());
}

export function storeHealth(): StoreHealth {
  return health;
}

export function subscribeStoreHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests, and "Clear cache": forget past failures. */
export function resetStoreHealth(): void {
  health = CLEAN;
  listeners.forEach((l) => l());
}

/** Out of space: retrying the next tile will fail the same way. */
export function isQuotaError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "QuotaExceededError";
}

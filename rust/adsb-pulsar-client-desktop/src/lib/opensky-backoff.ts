/**
 * Backoff for followed aircraft OpenSky has no data on.
 *
 * A followed aircraft the receiver never placed has no loss time, so the
 * loss cap in `computeWatch` never ends its watch: an aircraft OpenSky does not
 * know was asked for on every poll for as long as it was followed. Instead,
 * each poll that covered it and came back without it pushes the next request
 * further out (15 s, 30 s, 60 s, ...). Once the next request would fall past
 * {@link NO_DATA_GIVE_UP_MS} of no data, it is not asked for again until the
 * user follows it afresh, or the receiver places it.
 *
 * Between probes the aircraft is left out of the watch list, so a list that
 * holds nothing else costs no credits at all.
 */

/** Delay before the first probe after an empty answer. Doubles each time. */
export const NO_DATA_FIRST_RETRY_MS = 15_000;
/** How long an aircraft may go without data before it is no longer asked for. */
export const NO_DATA_GIVE_UP_MS = 5 * 60_000;

export interface NoDataEntry {
  /** The first poll that came back without it. */
  sinceMs: number;
  /** The delay that led to `nextProbeMs`. */
  delayMs: number;
  /** When it is asked for again. */
  nextProbeMs: number;
  /** Given up: no longer asked for. */
  stopped: boolean;
}

/** By uppercase hex. */
export type NoDataBackoff = ReadonlyMap<string, NoDataEntry>;

export const EMPTY_BACKOFF: NoDataBackoff = new Map();

/**
 * Folds one poll in. `asked` holds the aircraft the service had accepted, each
 * with when it was accepted: only a poll made after that answers for it.
 * Returns the same map when nothing changed.
 */
export function recordPoll(
  backoff: NoDataBackoff,
  poll: { pollMs: number; named: ReadonlySet<string>; asked: ReadonlyMap<string, number> },
): NoDataBackoff {
  const { pollMs, named, asked } = poll;
  let next: Map<string, NoDataEntry> | null = null;
  const edit = () => (next ??= new Map(backoff));
  for (const [hex, askedAt] of asked) {
    if (askedAt >= pollMs) continue;
    const entry = backoff.get(hex);
    if (named.has(hex)) {
      if (entry) edit().delete(hex);
      continue;
    }
    if (entry?.stopped) continue;
    const delayMs = entry ? entry.delayMs * 2 : NO_DATA_FIRST_RETRY_MS;
    const sinceMs = entry?.sinceMs ?? pollMs;
    const nextProbeMs = pollMs + delayMs;
    edit().set(hex, {
      sinceMs,
      delayMs,
      nextProbeMs,
      stopped: nextProbeMs - sinceMs > NO_DATA_GIVE_UP_MS,
    });
  }
  return next ?? backoff;
}

/** The aircraft to leave out of the watch list at `now`. */
export function heldBack(backoff: NoDataBackoff, now: number): Set<string> {
  const out = new Set<string>();
  for (const [hex, e] of backoff) if (e.stopped || now < e.nextProbeMs) out.add(hex);
  return out;
}

/**
 * Drops what no longer applies: an aircraft no longer followed (following it
 * again starts afresh), or one the receiver placed after its backoff began.
 * Returns the same map when nothing changed.
 */
export function pruneBackoff(
  backoff: NoDataBackoff,
  inputs: { followed: Iterable<string>; lastLocalMs: (hex: string) => number | null },
): NoDataBackoff {
  const followed = new Set(inputs.followed);
  let next: Map<string, NoDataEntry> | null = null;
  for (const [hex, e] of backoff) {
    const local = inputs.lastLocalMs(hex);
    if (!followed.has(hex) || (local !== null && local > e.sinceMs)) {
      next ??= new Map(backoff);
      next.delete(hex);
    }
  }
  return next ?? backoff;
}

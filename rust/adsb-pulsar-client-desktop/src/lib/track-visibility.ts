/**
 * Pure helpers for the hidden-tracks sets behind the map's eye toggles.
 *
 * Kept out of `page.tsx` so the scoping rule below is directly testable — it is
 * the one part of this feature that is easy to get subtly wrong.
 */

/**
 * Toggle visibility for a *subset* of a section's tracks.
 *
 * The aircraft table's group eye may legitimately replace a whole section's set,
 * because the hexes it passes *are* the whole section. The Simulation panel's
 * trajectories are only part of the live section, so it must union/subtract just
 * its own hexes — replacing the set would silently reveal every other hidden
 * live aircraft.
 *
 * Hides unless all of `hexIdents` are already hidden, mirroring the all-or-
 * nothing rule the table's group eye uses (there is no partial state).
 *
 * @returns a new set; `undefined` when nothing is left hidden, so callers can
 *   drop the section key entirely rather than storing an empty set.
 */
export function toggleScopedVisibility(
  hidden: ReadonlySet<string> | undefined,
  hexIdents: string[],
): Set<string> | undefined {
  const next = new Set(hidden ?? []);
  const allHidden = hexIdents.length > 0 && hexIdents.every((h) => next.has(h));
  for (const h of hexIdents) {
    if (allHidden) next.delete(h);
    else next.add(h);
  }
  return next.size === 0 ? undefined : next;
}

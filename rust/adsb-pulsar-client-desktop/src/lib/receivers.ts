/**
 * Which receiver the app is showing, and where it is.
 *
 * The database's location history wins: it is what the recorder measured
 * every stored fix from, and it is the only source a remote desktop shares
 * with the daemon. The Settings location is the fallback for a desktop with
 * no database location (live-only, or a recorder that predates the history).
 */
import type { ReceiverPoint } from "./aircraft-details";
import type { ReceiverSummary } from "./types";

/** A receiver position with its altitude stated, known or not. */
export type ReceiverLocation = ReceiverPoint & { alt: number | null };

export interface ResolvedReceiver {
  /** The receiver being shown, when one is known. */
  sourceId: string | null;
  location: ReceiverLocation | undefined;
  /** Where `location` came from. */
  source: "database" | "settings" | null;
}

/**
 * The receiver to show: the one selected if the database knows it, else this
 * app's own, else the only one with a location, else the first with one.
 */
export function pickReceiver(
  receivers: ReceiverSummary[],
  selectedId: string | null,
  ownId: string | null
): ReceiverSummary | null {
  const byId = (id: string | null) =>
    id == null ? undefined : receivers.find((r) => r.source_id === id);
  const located = receivers.filter((r) => r.current != null);
  return byId(selectedId) ?? byId(ownId) ?? located[0] ?? null;
}

/** The receiver to show and its location (see the module comment). */
export function resolveReceiverLocation(
  receivers: ReceiverSummary[],
  selectedId: string | null,
  ownId: string | null,
  settings: ReceiverLocation | undefined
): ResolvedReceiver {
  const picked = pickReceiver(receivers, selectedId, ownId);
  const current = picked?.current;
  if (picked && current) {
    const { latitude, longitude, altitude_ft } = current.position;
    return {
      sourceId: picked.source_id,
      location: { lat: latitude, lng: longitude, alt: altitude_ft },
      source: "database",
    };
  }
  // Settings describe THIS app's receiver; another one stays unlocated.
  if (picked && picked.source_id !== ownId) {
    return { sourceId: picked.source_id, location: undefined, source: null };
  }
  return {
    sourceId: picked?.source_id ?? ownId,
    location: settings,
    source: settings ? "settings" : null,
  };
}

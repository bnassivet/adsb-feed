"use client";
import type { HistoryEntry } from "@/lib/opensky-history";

export interface OpenSkyHistoryDetails {
  entry: HistoryEntry | null;
  /** Why a fetch is impossible (anonymous service, older than 30 days...), or null. */
  unavailable: string | null;
  /** Estimated credits per call. */
  cost: number;
  onFetch: () => void;
  /** Whether the fetched flight is hidden from the map (kept, not discarded). */
  hidden: boolean;
  onToggleHidden: () => void;
  onDiscard: () => void;
}

function hhmm(epochS: number): string {
  return new Date(epochS * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The details panel's OpenSky line for a recorded flight: fetch OpenSky's version of it. */
export function OpenSkyHistorySection({
  entry,
  unavailable,
  cost,
  onFetch,
  hidden,
  onToggleHidden,
  onDiscard,
}: OpenSkyHistoryDetails) {
  const loading = entry?.kind === "loading";
  return (
    <div className="border-t border-slate-800 pt-2 mt-2 text-xs" data-testid="opensky-history-section">
      <div className="text-[10px] text-slate-500 uppercase mb-1">OpenSky</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onFetch}
          disabled={unavailable !== null || loading}
          title={unavailable ?? `Draw OpenSky's track of this same flight (about ${cost} credits a call, at most two)`}
          className="px-2 py-0.5 rounded border border-violet-600 text-violet-200 hover:bg-violet-900/40 disabled:opacity-40"
        >
          {loading ? "Fetching…" : "Fetch from OpenSky"}
        </button>
        {entry?.kind === "done" && (
          <>
            <button type="button" onClick={onToggleHidden} className="text-slate-500 hover:text-slate-300">
              {hidden ? "Show" : "Hide"}
            </button>
            <button
              type="button"
              onClick={onDiscard}
              title="Forget it: drawing it again means fetching it again"
              className="text-slate-500 hover:text-slate-300"
            >
              Discard
            </button>
          </>
        )}
      </div>
      {entry?.kind === "done" && (
        <div className="text-[11px] text-slate-500 mt-1">
          <p>
            {entry.track.callsign?.trim() || entry.track.icao24} · {hhmm(entry.track.start_time)}–
            {hhmm(entry.track.end_time)} · {entry.track.path.length} waypoints
          </p>
          <p className={entry.gaps.count > 0 ? "text-violet-300" : undefined}>
            {entry.gaps.count > 0
              ? `${entry.gaps.count} gap${entry.gaps.count > 1 ? "s" : ""} filled, ${Math.round(entry.gaps.seconds / 60)} min`
              : "No gap: the receiver heard all of it"}
          </p>
          {entry.stored && <p>From storage: no credits spent</p>}
        </div>
      )}
      {entry?.kind === "mismatch" && (
        <p className="text-[11px] text-amber-400 mt-1">OpenSky&apos;s flight doesn&apos;t match: {entry.reason}</p>
      )}
      {entry?.kind === "none" && <p className="text-[11px] text-slate-500 mt-1">OpenSky has no track of this flight.</p>}
      {entry?.kind === "error" && (
        <p role="alert" className="text-[11px] text-red-400 mt-1">{entry.message}</p>
      )}
      {unavailable && <p className="text-[11px] text-slate-500 mt-1">{unavailable}</p>}
    </div>
  );
}

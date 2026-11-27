"use client";
import type { BackfillState } from "@/hooks/useOpenSky";
import type { OpenSkyFollowStatus } from "@/lib/opensky";

export interface OpenSkyDetails {
  /** When OpenSky last placed this aircraft (epoch ms), or null. */
  lastOpenSkyMs: number | null;
  /** Whether this aircraft is currently asked of OpenSky. */
  watched: boolean;
  /** Whether the user follows it: only a followed aircraft is ever asked for. */
  followed: boolean;
  onToggleFollow: () => void;
  /** Why it cannot be followed (simulated, service unreachable), or null. */
  followUnavailable?: string | null;
  backfill: BackfillState | null;
  /** Why the button is disabled (anonymous service, simulated aircraft...), or null. */
  disabledReason: string | null;
  onBackfill: () => void;
  /** Discards the backfill. */
  onClearBackfill: () => void;
  /** Whether the backfill is hidden from the map (kept, not discarded). */
  hidden: boolean;
  onToggleHidden: () => void;
  nowMs: number;
  /** What following has produced so far (openSkyFollowStatus). Absent, the
   *  line is derived from `followed` / `watched` / `lastOpenSkyMs` alone. */
  status?: OpenSkyFollowStatus;
  /** When OpenSky last heard the aircraft, placed or not (epoch ms). */
  lastContactMs?: number | null;
  /** When the last poll arrived (epoch ms). */
  lastPollMs?: number | null;
  /** While backing off on no data: when OpenSky is asked again (epoch ms). */
  retryAtMs?: number | null;
}

const secondsAgo = (nowMs: number, t: number) => Math.max(0, Math.round((nowMs - t) / 1000));

/** The status line: why there is, or is not, something on the map. */
function statusLine(p: {
  status: OpenSkyFollowStatus | undefined;
  lastOpenSkyMs: number | null;
  followed: boolean;
  watched: boolean;
  lastContactMs: number | null;
  lastPollMs: number | null;
  retryAtMs: number | null;
  nowMs: number;
}): string {
  const { status, lastOpenSkyMs, followed, watched, lastContactMs, lastPollMs, retryAtMs, nowMs } = p;
  const kind: OpenSkyFollowStatus =
    status ??
    (lastOpenSkyMs !== null ? "placed" : !followed ? "not-followed" : watched ? "waiting-answer" : "pending");
  switch (kind) {
    case "placed":
      return lastOpenSkyMs !== null
        ? `Last OpenSky position ${secondsAgo(nowMs, lastOpenSkyMs)} s ago`
        : "Placed by OpenSky";
    case "not-followed":
      return "Not followed: select Follow to ask OpenSky for it";
    case "pending":
      return "Followed: asked for once the receiver loses it (within 5 min / 250 NM)";
    case "waiting-answer":
      return status ? "Asked OpenSky, waiting for its next poll…" : "Following through OpenSky…";
    case "no-data": {
      const asked = lastPollMs !== null ? ` (asked ${secondsAgo(nowMs, lastPollMs)} s ago)` : "";
      const retry =
        retryAtMs !== null ? `. Asking again in ${Math.max(0, Math.round((retryAtMs - nowMs) / 1000))} s` : "";
      return `OpenSky has no data on this aircraft${asked}: nothing to draw${retry}`;
    }
    case "gave-up":
      return "OpenSky had no data on this aircraft for 5 min: stopped asking. Follow it again to retry";
    case "no-position":
      return lastContactMs !== null
        ? `OpenSky knows it but has no position (last contact ${secondsAgo(nowMs, lastContactMs)} s ago): listed, not drawn`
        : "OpenSky knows it but has no position: listed, not drawn";
  }
}

/** The details panel's OpenSky lines: last OpenSky fix, and the backfill button. */
export function OpenSkyGapSection({
  lastOpenSkyMs,
  watched,
  followed,
  onToggleFollow,
  followUnavailable = null,
  backfill,
  disabledReason,
  onBackfill,
  onClearBackfill,
  hidden,
  onToggleHidden,
  nowMs,
  status,
  lastContactMs = null,
  lastPollMs = null,
  retryAtMs = null,
}: OpenSkyDetails) {
  const loading = backfill?.kind === "loading";
  return (
    <div className="border-t border-slate-800 pt-2 mt-2 text-xs" data-testid="opensky-gap-section">
      <div className="text-[10px] text-slate-500 uppercase mb-1">OpenSky</div>
      <p className="text-slate-400">
        {statusLine({ status, lastOpenSkyMs, followed, watched, lastContactMs, lastPollMs, retryAtMs, nowMs })}
      </p>
      <div className="flex flex-wrap items-center gap-2 mt-1">
        <button
          type="button"
          onClick={onToggleFollow}
          disabled={!followed && followUnavailable !== null}
          title={
            followUnavailable ??
            (followed
              ? "Stop asking OpenSky for this aircraft"
              : "Ask OpenSky for this aircraft while the receiver has lost it (spends credits on every poll)")
          }
          className="px-2 py-0.5 rounded border border-violet-600 text-violet-200 hover:bg-violet-900/40 disabled:opacity-40"
        >
          {followed ? "Stop following" : "Follow on OpenSky"}
        </button>
        <button
          type="button"
          onClick={onBackfill}
          disabled={disabledReason !== null || loading}
          title={disabledReason ?? "Draw OpenSky's track of this flight since departure (4 credits)"}
          className="px-2 py-0.5 rounded border border-violet-600 text-violet-200 hover:bg-violet-900/40 disabled:opacity-40"
        >
          {loading ? "Fetching…" : "Fill gaps (OpenSky)"}
        </button>
        {backfill?.kind === "done" && (
          <>
            <button type="button" onClick={onToggleHidden} className="text-slate-500 hover:text-slate-300">
              {hidden ? "Show track" : "Hide track"}
            </button>
            <button
              type="button"
              onClick={onClearBackfill}
              title="Forget it: drawing it again means fetching it again"
              className="text-slate-500 hover:text-slate-300"
            >
              Discard
            </button>
          </>
        )}
      </div>
      {backfill?.kind === "done" && (
        <p className="text-[11px] text-slate-500 mt-1">
          {backfill.track.path.length < 2
            ? "OpenSky's track has no positions to draw"
            : `${backfill.track.path.length} waypoints since ${new Date(backfill.track.start_time * 1000).toLocaleTimeString()}`}
        </p>
      )}
      {backfill?.kind === "none" && (
        <p className="text-[11px] text-slate-500 mt-1">OpenSky has no live track for this aircraft.</p>
      )}
      {backfill?.kind === "error" && (
        <p role="alert" className="text-[11px] text-red-400 mt-1">{backfill.message}</p>
      )}
      {disabledReason && <p className="text-[11px] text-slate-500 mt-1">{disabledReason}</p>}
    </div>
  );
}

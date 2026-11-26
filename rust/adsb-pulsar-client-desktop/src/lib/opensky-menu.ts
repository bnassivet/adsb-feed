/**
 * The OpenSky part of a track's context menu (right-click on the map or a
 * table row). Built from the very objects the details panel's OpenSky lines
 * take, so the two always offer the same actions with the same rules.
 */
import type { OpenSkyDetails } from "@/components/OpenSkyGapSection";
import type { OpenSkyHistoryDetails } from "@/components/OpenSkyHistorySection";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Why it is disabled, or what it does. */
  title?: string;
}

/** What a live backfill costs (OpenSky `/tracks`, time=0). */
const BACKFILL_CREDITS = 4;

export function openSkyMenuItems(actions: {
  /** Gap filling for a live or OpenSky aircraft, while the layer is on. */
  gap: OpenSkyDetails | null;
  /** OpenSky's version of a recorded flight. */
  history: OpenSkyHistoryDetails | null;
  /** Turns the OpenSky layer on; given only while it is off. */
  onTurnOn?: () => void;
}): MenuItem[] {
  const items: MenuItem[] = [];
  const { gap, history, onTurnOn } = actions;

  if (onTurnOn) items.push({ label: "Turn on OpenSky", onSelect: onTurnOn });

  if (gap) {
    const followBlocked = !gap.followed && (gap.followUnavailable ?? null) !== null;
    items.push({
      label: gap.followed ? "Stop following" : "Follow on OpenSky",
      onSelect: gap.onToggleFollow,
      disabled: followBlocked || undefined,
      title: followBlocked ? (gap.followUnavailable ?? undefined) : undefined,
    });
    if (gap.backfill?.kind === "done") {
      items.push(
        { label: gap.hidden ? "Show OpenSky track" : "Hide OpenSky track", onSelect: gap.onToggleHidden },
        { label: "Discard OpenSky track", onSelect: gap.onClearBackfill },
      );
    } else {
      const loading = gap.backfill?.kind === "loading";
      items.push({
        label: loading ? "Filling gaps…" : `Fill gaps (OpenSky), ${BACKFILL_CREDITS} credits`,
        onSelect: gap.onBackfill,
        disabled: loading || gap.disabledReason !== null || undefined,
        title: gap.disabledReason ?? undefined,
      });
    }
  }

  if (history) {
    if (history.entry?.kind === "done") {
      items.push(
        { label: history.hidden ? "Show OpenSky flight" : "Hide OpenSky flight", onSelect: history.onToggleHidden },
        { label: "Discard OpenSky flight", onSelect: history.onDiscard },
      );
    } else {
      const loading = history.entry?.kind === "loading";
      items.push({
        label: loading ? "Fetching flight…" : `Fetch flight from OpenSky, about ${history.cost} credits`,
        onSelect: history.onFetch,
        disabled: loading || history.unavailable !== null || undefined,
        title: history.unavailable ?? undefined,
      });
    }
  }

  return items;
}

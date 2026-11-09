import type { AircraftTrack } from "@/lib/types";

/**
 * Filter history tracks by a time range slider.
 *
 * The slider operates on an integer scale from 0 to trackHistoryHours:
 * - sliderMin=0 (leftmost) represents the oldest bound (trackHistoryHours ago)
 * - sliderMax=trackHistoryHours (rightmost) represents "now"
 *
 * A track is visible when its "hours ago" value falls within the selected window.
 * Fast path: when the slider is at full range, returns the input array unchanged.
 */
export function filterHistoryByTimeRange(
  tracks: AircraftTrack[],
  trackHistoryHours: number,
  sliderMin: number,
  sliderMax: number,
  now: number,
): AircraftTrack[] {
  // Fast path: full range selected — skip filtering
  if (sliderMin === 0 && sliderMax >= trackHistoryHours) {
    return tracks;
  }

  const MS_PER_HOUR = 3_600_000;
  // Convert slider positions to "hours ago" bounds
  const minHoursAgo = trackHistoryHours - sliderMax; // right thumb → newer bound
  const maxHoursAgo = trackHistoryHours - sliderMin; // left thumb → older bound

  return tracks.filter((track) => {
    const hoursAgo = (now - track.last_seen) / MS_PER_HOUR;
    return hoursAgo >= minHoursAgo && hoursAgo <= maxHoursAgo;
  });
}

/** A history window expressed the way people (and the agent) say it. */
export interface HistoryWindow {
  /** Older bound, in hours before now. */
  fromHoursAgo: number;
  /** Newer bound, in hours before now (0 = now). */
  toHoursAgo: number;
}

/**
 * Convert "the last `depthHours`, ending `endHoursAgo` before now" into slider
 * positions for {@link filterHistoryByTimeRange}.
 *
 * The slider moves in whole hours, so fractional bounds are widened outward
 * (1.5 h shows 2 h) and the window is never narrower than one hour. Nothing
 * older than `trackHistoryHours` is held in memory, so a deeper request is
 * clamped to retention and reported with `clamped: true`. Widening retention
 * is a Settings change, not something this window can do.
 */
export function historyWindowToSlider(
  trackHistoryHours: number,
  depthHours: number,
  endHoursAgo = 0,
): HistoryWindow & { sliderMin: number; sliderMax: number; clamped: boolean } {
  const retention = Math.max(1, Math.floor(trackHistoryHours));
  const end = Math.max(0, endHoursAgo);
  let clamped = false;

  let to = Math.floor(end);
  if (to > retention - 1) {
    to = retention - 1;
    clamped = true;
  }
  let from = Math.max(Math.ceil(end + Math.max(0, depthHours)), to + 1);
  if (from > retention) {
    from = retention;
    clamped = true;
  }

  return {
    sliderMin: retention - from,
    sliderMax: retention - to,
    fromHoursAgo: from,
    toHoursAgo: to,
    clamped,
  };
}

/** Inverse of {@link historyWindowToSlider}: slider positions → hours ago. */
export function sliderToHistoryWindow(
  trackHistoryHours: number,
  sliderMin: number,
  sliderMax: number,
): HistoryWindow {
  return {
    fromHoursAgo: trackHistoryHours - sliderMin,
    toHoursAgo: trackHistoryHours - sliderMax,
  };
}

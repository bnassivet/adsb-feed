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

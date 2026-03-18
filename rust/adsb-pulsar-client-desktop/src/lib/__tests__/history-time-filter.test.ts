import { describe, it, expect } from "vitest";
import { filterHistoryByTimeRange } from "../history-time-filter";
import type { AircraftTrack } from "@/lib/types";

function makeTrack(lastSeenMs: number): AircraftTrack {
  return {
    hex_ident: "ABC123",
    callsign: null,
    altitude: null,
    ground_speed: null,
    track: null,
    latitude: null,
    longitude: null,
    vertical_rate: null,
    squawk: null,
    is_on_ground: null,
    timestamp: "",
    positions: [],
    first_seen: lastSeenMs,
    last_seen: lastSeenMs,
    message_count: 0,
  };
}

describe("filterHistoryByTimeRange", () => {
  const HOUR = 3_600_000;

  it("returns all tracks when slider is at full range (fast path)", () => {
    const now = Date.now();
    const tracks = [
      makeTrack(now - 1 * HOUR),
      makeTrack(now - 12 * HOUR),
      makeTrack(now - 23 * HOUR),
    ];
    const result = filterHistoryByTimeRange(tracks, 24, 0, 24, now);
    expect(result).toBe(tracks); // same reference — fast path
  });

  it("filters tracks outside the selected time window", () => {
    const now = Date.now();
    // Track seen 20h ago — should be excluded by window 0-12h ago
    const oldTrack = makeTrack(now - 20 * HOUR);
    // Track seen 6h ago — should be included
    const recentTrack = makeTrack(now - 6 * HOUR);
    const tracks = [oldTrack, recentTrack];

    // Slider: min=12, max=24 → window is 0h ago to 12h ago
    const result = filterHistoryByTimeRange(tracks, 24, 12, 24, now);
    expect(result).toEqual([recentTrack]);
  });

  it("includes track exactly at the boundary", () => {
    const now = Date.now();
    // Track seen exactly 12h ago
    const boundaryTrack = makeTrack(now - 12 * HOUR);
    const tracks = [boundaryTrack];

    // Slider: min=12, max=24 → window is 0h ago to 12h ago (inclusive)
    const result = filterHistoryByTimeRange(tracks, 24, 12, 24, now);
    expect(result).toEqual([boundaryTrack]);
  });

  it("excludes track outside range", () => {
    const now = Date.now();
    // Track seen 2h ago — outside window of 6-12h ago
    const track = makeTrack(now - 2 * HOUR);
    const tracks = [track];

    // Slider: min=12, max=18 → window is 6h ago to 12h ago
    const result = filterHistoryByTimeRange(tracks, 24, 12, 18, now);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    const result = filterHistoryByTimeRange([], 24, 0, 24, Date.now());
    expect(result).toEqual([]);
  });

  it("handles narrowed range correctly", () => {
    const now = Date.now();
    const t3h = makeTrack(now - 3 * HOUR);  // 3h ago
    const t8h = makeTrack(now - 8 * HOUR);  // 8h ago
    const t15h = makeTrack(now - 15 * HOUR); // 15h ago
    const t22h = makeTrack(now - 22 * HOUR); // 22h ago
    const tracks = [t3h, t8h, t15h, t22h];

    // Slider: min=6, max=18 → window is 6h ago to 18h ago
    const result = filterHistoryByTimeRange(tracks, 24, 6, 18, now);
    expect(result).toEqual([t8h, t15h]);
  });
});

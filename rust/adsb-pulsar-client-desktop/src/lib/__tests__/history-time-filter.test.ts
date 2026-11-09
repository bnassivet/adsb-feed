import { describe, it, expect } from "vitest";
import {
  filterHistoryByTimeRange,
  historyWindowToSlider,
  sliderToHistoryWindow,
} from "../history-time-filter";
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

describe("historyWindowToSlider", () => {
  it("maps 'the last 4 hours' onto the newest end of the slider", () => {
    expect(historyWindowToSlider(24, 4)).toEqual({
      sliderMin: 20,
      sliderMax: 24,
      fromHoursAgo: 4,
      toHoursAgo: 0,
      clamped: false,
    });
  });

  it("supports a window that ends in the past", () => {
    // From 6 h ago to 2 h ago
    expect(historyWindowToSlider(24, 4, 2)).toMatchObject({
      sliderMin: 18,
      sliderMax: 22,
      fromHoursAgo: 6,
      toHoursAgo: 2,
      clamped: false,
    });
  });

  it("clamps a depth beyond retention and says so", () => {
    expect(historyWindowToSlider(2, 4)).toEqual({
      sliderMin: 0,
      sliderMax: 2,
      fromHoursAgo: 2,
      toHoursAgo: 0,
      clamped: true,
    });
  });

  it("widens fractional hours outward to whole slider steps", () => {
    // 1.5 h → the slider moves in whole hours, so show 2 h rather than 1
    expect(historyWindowToSlider(24, 1.5)).toMatchObject({ sliderMin: 22, sliderMax: 24, fromHoursAgo: 2 });
  });

  it("never produces an empty window", () => {
    const r = historyWindowToSlider(24, 0);
    expect(r.sliderMax - r.sliderMin).toBeGreaterThanOrEqual(1);
    // An end bound at or past retention still leaves the oldest hour visible
    const past = historyWindowToSlider(24, 4, 30);
    expect(past).toMatchObject({ sliderMin: 0, sliderMax: 1, clamped: true });
  });

  it("round-trips through the filter: 4 h depth keeps a 3 h-old track, drops a 5 h-old one", () => {
    const now = 100 * 3_600_000;
    const t3h = makeTrack(now - 3 * 3_600_000);
    const t5h = makeTrack(now - 5 * 3_600_000);
    const { sliderMin, sliderMax } = historyWindowToSlider(24, 4);
    expect(filterHistoryByTimeRange([t3h, t5h], 24, sliderMin, sliderMax, now)).toEqual([t3h]);
  });
});

describe("sliderToHistoryWindow", () => {
  it("reports the window in hours ago", () => {
    expect(sliderToHistoryWindow(24, 20, 24)).toEqual({ fromHoursAgo: 4, toHoursAgo: 0 });
    expect(sliderToHistoryWindow(24, 0, 24)).toEqual({ fromHoursAgo: 24, toHoursAgo: 0 });
  });
});

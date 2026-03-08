import { describe, it, expect } from "vitest";
import {
  buildAltitudeBins,
  buildHeatmapGrid,
  computeDbHistorySummary,
  formatTimeChartData,
  formatAdaptiveTimeLabel,
  granularityToNumBuckets,
} from "../db-history-analytics";
import type { AircraftSummary, HourlyHeatmapCell, TimeDistributionBucket } from "../types";

function makeSummary(overrides: Partial<AircraftSummary> = {}): AircraftSummary {
  return {
    hex_ident: "A1B2C3",
    callsign: "TEST",
    position_count: 10,
    first_seen_ms: 1705315800000,
    last_seen_ms: 1705316100000,
    min_altitude: 30000,
    max_altitude: 35000,
    ...overrides,
  };
}

describe("buildAltitudeBins", () => {
  it("returns 10 zero-count bins for empty input", () => {
    const bins = buildAltitudeBins([]);
    expect(bins).toHaveLength(10);
    expect(bins.every((b) => b.count === 0)).toBe(true);
    expect(bins[0].label).toBe("0-5k");
    expect(bins[9].label).toBe("45-50k");
  });

  it("places altitude 35000 in bin index 7 (35-40k)", () => {
    const bins = buildAltitudeBins([makeSummary({ max_altitude: 35000 })]);
    expect(bins[7].count).toBe(1);
    expect(bins[7].label).toBe("35-40k");
    // All other bins should be 0
    expect(bins.filter((b) => b.count > 0)).toHaveLength(1);
  });

  it("places altitude 0 in bin index 0", () => {
    const bins = buildAltitudeBins([makeSummary({ max_altitude: 0 })]);
    expect(bins[0].count).toBe(1);
  });

  it("places altitude >= 45000 in the last bin", () => {
    const bins = buildAltitudeBins([makeSummary({ max_altitude: 50000 })]);
    expect(bins[9].count).toBe(1);
  });

  it("ignores null altitude", () => {
    const bins = buildAltitudeBins([makeSummary({ max_altitude: null })]);
    expect(bins.every((b) => b.count === 0)).toBe(true);
  });

  it("counts multiple aircraft in same bin", () => {
    const bins = buildAltitudeBins([
      makeSummary({ max_altitude: 36000 }),
      makeSummary({ max_altitude: 37000 }),
    ]);
    expect(bins[7].count).toBe(2);
  });
});

describe("computeDbHistorySummary", () => {
  it("returns zeros for empty input", () => {
    const result = computeDbHistorySummary([]);
    expect(result.totalTracks).toBe(0);
    expect(result.totalPositions).toBe(0);
    expect(result.totalRawMessages).toBe(0);
    expect(result.avgDurationMs).toBe(0);
  });

  it("computes correct totals and average", () => {
    const summaries = [
      makeSummary({
        position_count: 10,
        first_seen_ms: 1000,
        last_seen_ms: 11000,
      }),
      makeSummary({
        position_count: 20,
        first_seen_ms: 2000,
        last_seen_ms: 7000,
      }),
    ];
    const result = computeDbHistorySummary(summaries);
    expect(result.totalTracks).toBe(2);
    expect(result.totalPositions).toBe(30);
    expect(result.totalRawMessages).toBe(0);
    expect(result.avgDurationMs).toBe(7500); // (10000 + 5000) / 2
  });

  it("includes raw message count when provided", () => {
    const summaries = [
      makeSummary({ position_count: 5 }),
    ];
    const result = computeDbHistorySummary(summaries, 150);
    expect(result.totalTracks).toBe(1);
    expect(result.totalPositions).toBe(5);
    expect(result.totalRawMessages).toBe(150);
  });
});

describe("granularityToNumBuckets", () => {
  const MS_1H = 60 * 60 * 1000;
  const MS_24H = 24 * MS_1H;
  const MS_7D = 7 * MS_24H;
  const MS_30D = 30 * MS_24H;

  it("returns 24 buckets for 24h range with 1h granularity", () => {
    expect(granularityToNumBuckets("1h", MS_24H)).toBe(24);
  });

  it("returns 6 buckets for 24h range with 4h granularity", () => {
    expect(granularityToNumBuckets("4h", MS_24H)).toBe(6);
  });

  it("returns 7 buckets for 1 week range with day granularity", () => {
    expect(granularityToNumBuckets("day", MS_7D)).toBe(7);
  });

  it("returns 4 buckets for 30 day range with week granularity", () => {
    // 30 / 7 ≈ 4.28 → floors to 4
    expect(granularityToNumBuckets("week", MS_30D)).toBe(4);
  });

  it("returns 3 buckets for 90 day range with month granularity", () => {
    expect(granularityToNumBuckets("month", 90 * MS_24H)).toBe(3);
  });

  it("returns at least 1 bucket even for tiny ranges", () => {
    expect(granularityToNumBuckets("month", MS_1H)).toBe(1);
  });

  it("caps at 500 buckets for very large ranges", () => {
    // 365 days with 1h granularity = 8760, should cap
    expect(granularityToNumBuckets("1h", 365 * MS_24H)).toBe(500);
  });
});

describe("formatAdaptiveTimeLabel", () => {
  // Jan 15 2024 14:30 UTC
  const ts = Date.UTC(2024, 0, 15, 14, 30, 0);

  it("returns HH:MM for range ≤ 48h", () => {
    const rangeMs = 24 * 60 * 60 * 1000; // 24h
    const label = formatAdaptiveTimeLabel(ts, rangeMs, "UTC");
    expect(label).toMatch(/^14:30$/);
  });

  it("returns HH:MM for exactly 48h range", () => {
    const rangeMs = 48 * 60 * 60 * 1000;
    const label = formatAdaptiveTimeLabel(ts, rangeMs, "UTC");
    expect(label).toMatch(/^14:30$/);
  });

  it("returns MMM DD HH:MM for range ≤ 2 weeks (> 48h)", () => {
    const rangeMs = 7 * 24 * 60 * 60 * 1000; // 1 week
    const label = formatAdaptiveTimeLabel(ts, rangeMs, "UTC");
    expect(label).toMatch(/Jan 15 14:30/);
  });

  it("returns MMM DD for range > 2 weeks", () => {
    const rangeMs = 30 * 24 * 60 * 60 * 1000; // ~1 month
    const label = formatAdaptiveTimeLabel(ts, rangeMs, "UTC");
    expect(label).toMatch(/Jan 15/);
    // Should NOT contain time portion
    expect(label).not.toMatch(/14:30/);
  });

  it("falls back gracefully for invalid timezone", () => {
    const rangeMs = 24 * 60 * 60 * 1000;
    const label = formatAdaptiveTimeLabel(ts, rangeMs, "Invalid/Zone");
    // Should still return something parseable
    expect(label).toMatch(/\d{2}:\d{2}/);
  });
});

describe("formatTimeChartData", () => {
  it("formats buckets into labeled data with correct counts", () => {
    const buckets: TimeDistributionBucket[] = [
      { bucket_ms: 1705315200000, count: 5 },
      { bucket_ms: 1705318800000, count: 3 },
    ];
    const data = formatTimeChartData(buckets, "UTC");
    expect(data).toHaveLength(2);
    // Label format depends on environment (jsdom may not support timeZone option)
    // but structure and counts must be correct
    expect(data[0].count).toBe(5);
    expect(data[0].label).toMatch(/\d{2}:\d{2}/);
    expect(data[1].count).toBe(3);
    expect(data[1].label).toMatch(/\d{2}:\d{2}/);
  });

  it("returns empty array for empty input", () => {
    const data = formatTimeChartData([], "UTC");
    expect(data).toEqual([]);
  });

  it("preserves bucket_ms in output", () => {
    const buckets: TimeDistributionBucket[] = [
      { bucket_ms: 1705315200000, count: 1 },
    ];
    const data = formatTimeChartData(buckets, "UTC");
    expect(data[0].bucketMs).toBe(1705315200000);
  });
});

// --- buildHeatmapGrid ---

describe("buildHeatmapGrid", () => {
  // Midnight UTC for Jan 15, 16, 17 2024
  const DAY_MS = 24 * 60 * 60 * 1000;
  const JAN15 = Date.UTC(2024, 0, 15); // 1705276800000
  const JAN16 = JAN15 + DAY_MS;
  const JAN17 = JAN16 + DAY_MS;

  function makeCell(day_ms: number, hour: number, aircraft: number, messages: number): HourlyHeatmapCell {
    return { day_ms, hour, aircraft_count: aircraft, message_count: messages };
  }

  it("returns empty grid for empty input", () => {
    const grid = buildHeatmapGrid([], JAN15, JAN16);
    // Even with valid range, 1 day row is generated (all zeros)
    expect(grid.length).toBeGreaterThanOrEqual(1);
    expect(grid[0].hours.every((v) => v === 0)).toBe(true);
  });

  it("returns empty grid when startMs >= endMs", () => {
    const grid = buildHeatmapGrid([], JAN16, JAN15);
    expect(grid).toEqual([]);
  });

  it("zero-fills all 24 hours per row", () => {
    const cells = [makeCell(JAN15, 10, 5, 100)];
    const grid = buildHeatmapGrid(cells, JAN15, JAN15 + DAY_MS);
    expect(grid).toHaveLength(1);
    expect(grid[0].hours).toHaveLength(24);
    expect(grid[0].hours[10]).toBe(5); // aircraft_count by default
    expect(grid[0].hours[0]).toBe(0);
    expect(grid[0].hours[23]).toBe(0);
  });

  it("uses message_count when metric is 'messages'", () => {
    const cells = [makeCell(JAN15, 10, 5, 100)];
    const grid = buildHeatmapGrid(cells, JAN15, JAN15 + DAY_MS, "messages");
    expect(grid[0].hours[10]).toBe(100);
  });

  it("generates rows for each day in range, most recent first", () => {
    const cells = [
      makeCell(JAN15, 10, 3, 50),
      makeCell(JAN16, 14, 7, 200),
    ];
    const grid = buildHeatmapGrid(cells, JAN15, JAN17);
    // JAN15 and JAN16 should be present — JAN17 is the endDay (floored)
    expect(grid.length).toBeGreaterThanOrEqual(2);
    // Most recent first
    expect(grid[0].dayMs).toBeGreaterThanOrEqual(grid[1].dayMs);
  });

  it("includes day labels with weekday and date", () => {
    const cells = [makeCell(JAN15, 10, 1, 1)];
    const grid = buildHeatmapGrid(cells, JAN15, JAN15 + DAY_MS, "aircraft", "UTC");
    // Jan 15 2024 is a Monday
    expect(grid[0].dayLabel).toMatch(/Mon/);
    expect(grid[0].dayLabel).toMatch(/1\/15/);
  });

  it("handles multiple cells on the same day", () => {
    const cells = [
      makeCell(JAN15, 8, 2, 20),
      makeCell(JAN15, 14, 5, 80),
      makeCell(JAN15, 22, 1, 10),
    ];
    const grid = buildHeatmapGrid(cells, JAN15, JAN15 + DAY_MS);
    expect(grid[0].hours[8]).toBe(2);
    expect(grid[0].hours[14]).toBe(5);
    expect(grid[0].hours[22]).toBe(1);
    // Other hours should be 0
    expect(grid[0].hours[0]).toBe(0);
    expect(grid[0].hours[12]).toBe(0);
  });
});

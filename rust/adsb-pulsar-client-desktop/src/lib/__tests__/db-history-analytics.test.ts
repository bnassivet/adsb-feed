import { describe, it, expect } from "vitest";
import {
  buildAltitudeBins,
  computeDbHistorySummary,
  formatTimeChartData,
  formatAdaptiveTimeLabel,
  granularityToNumBuckets,
} from "../db-history-analytics";
import type { AircraftSummary, TimeDistributionBucket } from "../types";

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
    expect(result.avgDurationMs).toBe(7500); // (10000 + 5000) / 2
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

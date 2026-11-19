import { describe, it, expect } from "vitest";
import {
  buildAltitudeBins,
  buildHeatmapGrid,
  heatmapDisplayZone,
  buildHeatmapCellLookup,
  computeDbHistorySummary,
  formatTimeChartData,
  formatAdaptiveTimeLabel,
  granularityToNumBuckets,
} from "../db-history-analytics";
import type { AircraftSummary, FlightSummary, HourlyHeatmapCell, TimeDistributionBucket } from "../types";

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

  it("accepts FlightSummary objects", () => {
    const bins = buildAltitudeBins([
      makeFlightSummary({ max_altitude: 35000 }),
      makeFlightSummary({ max_altitude: 12000 }),
    ]);
    expect(bins[7].count).toBe(1); // 35-40k
    expect(bins[2].count).toBe(1); // 10-15k
  });
});

function makeFlightSummary(overrides: Partial<FlightSummary> = {}): FlightSummary {
  return {
    hex_ident: "A1B2C3",
    flight_num: 0,
    flight_id: "A1B2C3_0",
    callsign: "TEST",
    position_count: 10,
    first_seen_ms: 1705315800000,
    last_seen_ms: 1705316100000, // 5 min later
    min_altitude: 30000,
    max_altitude: 35000,
    ...overrides,
  };
}

describe("computeDbHistorySummary", () => {
  it("returns zeros for empty input", () => {
    const result = computeDbHistorySummary([]);
    expect(result.totalAircraft).toBe(0);
    expect(result.totalFlights).toBe(0);
    expect(result.totalPositions).toBe(0);
    expect(result.totalRawMessages).toBe(0);
    expect(result.avgFlightDurationMs).toBe(0);
  });

  it("computes correct totals from aircraft summaries", () => {
    const summaries = [
      makeSummary({ position_count: 10 }),
      makeSummary({ position_count: 20 }),
    ];
    const result = computeDbHistorySummary(summaries);
    expect(result.totalAircraft).toBe(2);
    expect(result.totalPositions).toBe(30);
    expect(result.totalRawMessages).toBe(0);
  });

  it("includes raw message count when provided", () => {
    const summaries = [makeSummary({ position_count: 5 })];
    const result = computeDbHistorySummary(summaries, 150);
    expect(result.totalAircraft).toBe(1);
    expect(result.totalPositions).toBe(5);
    expect(result.totalRawMessages).toBe(150);
  });

  it("computes avg duration from flights", () => {
    const summaries = [makeSummary()];
    const flights = [
      makeFlightSummary({ first_seen_ms: 1000, last_seen_ms: 11000 }), // 10s
      makeFlightSummary({ first_seen_ms: 2000, last_seen_ms: 7000 }),  // 5s
    ];
    const result = computeDbHistorySummary(summaries, 0, flights);
    expect(result.totalFlights).toBe(2);
    expect(result.avgFlightDurationMs).toBe(7500); // (10000 + 5000) / 2
  });

  it("returns zero avg duration when no flights", () => {
    const summaries = [makeSummary()];
    const result = computeDbHistorySummary(summaries, 0, []);
    expect(result.avgFlightDurationMs).toBe(0);
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
  it("reads no zone as the machine's local zone, like every other time in the app", () => {
    // Was UTC: in Local mode the panel passes no zone, so the time chart stayed
    // in UTC whatever Time Display said.
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const ts = Date.UTC(2024, 0, 15, 15, 0);
    for (const range of [3_600_000, 7 * 86_400_000, 60 * 86_400_000]) {
      expect(formatAdaptiveTimeLabel(ts, range)).toBe(formatAdaptiveTimeLabel(ts, range, local));
    }
    expect(formatAdaptiveTimeLabel(ts, 3_600_000, "America/New_York")).toBe("10:00");
  });

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

  function makeCell(day_ms: number, hour: number, aircraft: number, messages: number, raw: number = 0, flights: number = 0): HourlyHeatmapCell {
    return { day_ms, hour, aircraft_count: aircraft, message_count: messages, raw_message_count: raw, flight_count: flights };
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

  it("moves UTC cells to the display zone's day and hour", () => {
    // The server counts in UTC: 23:00 UTC on Jan 15 is 00:00 on Jan 16 in Paris
    // (CET, +1), and 22:00 UTC on Jul 15 is 00:00 on Jul 16 (CEST, +2).
    const JUL15 = Date.UTC(2024, 6, 15);
    const cells = [makeCell(JAN15, 23, 4, 40), makeCell(JUL15, 22, 6, 60)];
    const winter = buildHeatmapGrid(cells, Date.UTC(2024, 0, 15, 23, 30), Date.UTC(2024, 0, 16, 22, 30), "aircraft", "Europe/Paris");
    expect(winter.map((r) => r.dayLabel)).toEqual(["Tue 1/16"]);
    expect(winter[0].hours[0]).toBe(4);
    const summer = buildHeatmapGrid(cells, Date.UTC(2024, 6, 15, 22), Date.UTC(2024, 6, 16, 21), "aircraft", "Europe/Paris");
    expect(summer.map((r) => r.dayLabel)).toEqual(["Tue 7/16"]);
    expect(summer[0].hours[0]).toBe(6);
    // No zone: UTC, cells as they come.
    expect(buildHeatmapGrid(cells, JAN15, JAN15 + DAY_MS)[0].hours[23]).toBe(4);
  });

  it("adds up the two UTC hours that land on the repeated hour of the autumn change", () => {
    // Paris, 27 Oct 2024: 00:00 and 01:00 UTC are both 02:xx local.
    const OCT27 = Date.UTC(2024, 9, 27);
    const cells = [makeCell(OCT27, 0, 3, 30), makeCell(OCT27, 1, 2, 20)];
    const grid = buildHeatmapGrid(cells, OCT27, OCT27 + 3 * 3_600_000, "messages", "Europe/Paris");
    expect(grid[0].hours[2]).toBe(50);
  });

  it("labels a date key as that date whatever the zone", () => {
    // Far west of UTC, formatting the key in the zone would give the day before.
    const grid = buildHeatmapGrid([], Date.UTC(2024, 0, 15, 12), Date.UTC(2024, 0, 15, 13), "aircraft", "America/Los_Angeles");
    expect(grid.map((r) => r.dayLabel)).toEqual(["Mon 1/15"]);
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

  it("uses raw_message_count when metric is 'raw_messages'", () => {
    const cells = [makeCell(JAN15, 10, 5, 100, 3456)];
    const grid = buildHeatmapGrid(cells, JAN15, JAN15 + DAY_MS, "raw_messages");
    expect(grid[0].hours[10]).toBe(3456);
  });

  it("uses flight_count when metric is 'flights'", () => {
    const cells = [makeCell(JAN15, 10, 5, 100, 3456, 7)];
    const grid = buildHeatmapGrid(cells, JAN15, JAN15 + DAY_MS, "flights");
    expect(grid[0].hours[10]).toBe(7);
  });
});

// --- buildHeatmapCellLookup ---

describe("buildHeatmapCellLookup", () => {
  const JAN15 = Date.UTC(2024, 0, 15);

  function makeCell(day_ms: number, hour: number, aircraft: number, messages: number, raw: number = 0, flights: number = 0): HourlyHeatmapCell {
    return { day_ms, hour, aircraft_count: aircraft, message_count: messages, raw_message_count: raw, flight_count: flights };
  }

  it("creates lookup keyed by day_ms-hour", () => {
    const cells = [
      makeCell(JAN15, 10, 5, 100, 300),
      makeCell(JAN15, 14, 2, 50, 150),
    ];
    const lookup = buildHeatmapCellLookup(cells);
    expect(lookup.size).toBe(2);
    expect(lookup.get(`${JAN15}-10`)).toEqual(cells[0]);
    expect(lookup.get(`${JAN15}-14`)).toEqual(cells[1]);
  });

  it("keys cells by the local day and hour of the zone, like the grid", () => {
    // 23:00 UTC on Jan 15 is 00:00 on Jan 16 in Paris: the tooltip of that
    // column must show this cell, not the one at 00:00 UTC.
    const cells = [makeCell(JAN15, 23, 5, 100, 300, 2)];
    const lookup = buildHeatmapCellLookup(cells, "Europe/Paris");
    const JAN16 = JAN15 + 86_400_000;
    expect(lookup.get(`${JAN16}-0`)).toEqual({ ...cells[0], day_ms: JAN16, hour: 0 });
    expect(lookup.get(`${JAN15}-23`)).toBeUndefined();
  });

  it("adds up the two UTC hours of the autumn change, as the grid does", () => {
    const OCT27 = Date.UTC(2024, 9, 27);
    const lookup = buildHeatmapCellLookup([makeCell(OCT27, 0, 3, 30, 300, 1), makeCell(OCT27, 1, 2, 20, 200, 1)], "Europe/Paris");
    expect(lookup.get(`${OCT27}-2`)).toEqual({ day_ms: OCT27, hour: 2, aircraft_count: 5, message_count: 50, raw_message_count: 500, flight_count: 2 });
  });

  it("returns empty map for empty input", () => {
    const lookup = buildHeatmapCellLookup([]);
    expect(lookup.size).toBe(0);
  });

  it("allows quick access to all metrics for tooltip", () => {
    const cells = [makeCell(JAN15, 10, 5, 100, 300)];
    const lookup = buildHeatmapCellLookup(cells);
    const cell = lookup.get(`${JAN15}-10`)!;
    expect(cell.aircraft_count).toBe(5);
    expect(cell.message_count).toBe(100);
    expect(cell.raw_message_count).toBe(300);
  });
});

describe("heatmapDisplayZone", () => {
  const H = 3_600_000;
  it("keeps a whole-hour zone, summer time included", () => {
    expect(heatmapDisplayZone("Europe/Paris", Date.UTC(2024, 0, 1), Date.UTC(2024, 11, 31))).toBe("Europe/Paris");
    expect(heatmapDisplayZone("America/Toronto", Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 1) + H)).toBe("America/Toronto");
  });

  it("falls back to UTC where a local hour straddles two UTC hours", () => {
    expect(heatmapDisplayZone("Asia/Kolkata", Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 2))).toBe("UTC");
    expect(heatmapDisplayZone("Asia/Kathmandu", Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 2))).toBe("UTC");
  });

  it("is UTC for no zone or an unknown one", () => {
    expect(heatmapDisplayZone(undefined, 0, H)).toBe("UTC");
    expect(heatmapDisplayZone("Mars/Olympus_Mons", 0, H)).toBe("UTC");
  });
});

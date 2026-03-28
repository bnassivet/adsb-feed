import { describe, it, expect, vi, afterEach } from "vitest";
import { timeAgo, timeAgoLong, formatEventTime, formatBytes, formatWithTz } from "../format";

describe("timeAgo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats seconds", () => {
    vi.spyOn(Date, "now").mockReturnValue(30_000);
    expect(timeAgo(0)).toBe("30s ago");
  });

  it("formats minutes", () => {
    vi.spyOn(Date, "now").mockReturnValue(180_000);
    expect(timeAgo(0)).toBe("3m ago");
  });

  it("formats hours and minutes", () => {
    vi.spyOn(Date, "now").mockReturnValue(7_500_000);
    expect(timeAgo(0)).toBe("2h 5m ago");
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(45600)).toBe("44.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(5000000)).toBe("4.77 MB");
  });
});

describe("timeAgoLong", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats seconds when < 1 minute", () => {
    vi.spyOn(Date, "now").mockReturnValue(45_000);
    expect(timeAgoLong(0)).toBe("45s ago");
  });

  it("formats minutes when < 1 hour", () => {
    vi.spyOn(Date, "now").mockReturnValue(25 * 60_000);
    expect(timeAgoLong(0)).toBe("25m ago");
  });

  it("formats hours and minutes when < 1 day", () => {
    // 3h 15m = 195 min = 11700s
    vi.spyOn(Date, "now").mockReturnValue(11_700_000);
    expect(timeAgoLong(0)).toBe("3h 15m ago");
  });

  it("formats days and hours when < 30 days", () => {
    // 5d 2h
    const ms = (5 * 24 + 2) * 3600_000;
    vi.spyOn(Date, "now").mockReturnValue(ms);
    expect(timeAgoLong(0)).toBe("5d 2h ago");
  });

  it("formats months and days when >= 30 days", () => {
    // 75 days = 2 months + 15 days (using 30-day months)
    const ms = 75 * 24 * 3600_000;
    vi.spyOn(Date, "now").mockReturnValue(ms);
    expect(timeAgoLong(0)).toBe("2mo 15d ago");
  });

  it("formats exact months with no remainder", () => {
    const ms = 60 * 24 * 3600_000; // 60 days = 2mo 0d
    vi.spyOn(Date, "now").mockReturnValue(ms);
    expect(timeAgoLong(0)).toBe("2mo ago");
  });

  it("formats exact days with no remainder hours", () => {
    const ms = 3 * 24 * 3600_000; // exactly 3 days
    vi.spyOn(Date, "now").mockReturnValue(ms);
    expect(timeAgoLong(0)).toBe("3d ago");
  });

  it("handles future timestamps gracefully", () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    expect(timeAgoLong(5000)).toBe("0s ago");
  });
});

describe("formatEventTime", () => {
  it("formats a timestamp as a readable local datetime", () => {
    // 2026-02-23 15:30:00 UTC
    const ms = new Date("2026-02-23T15:30:00Z").getTime();
    const result = formatEventTime(ms);
    // Should contain date and time parts
    expect(result).toMatch(/2026/);
    expect(result).toMatch(/\d{2}:\d{2}/);
  });

  it("returns a non-empty string", () => {
    expect(formatEventTime(Date.now()).length).toBeGreaterThan(0);
  });
});

// A fixed UTC instant: 2026-02-23 15:30:45 UTC
const FIXED_MS = new Date("2026-02-23T15:30:45Z").getTime();

describe("formatWithTz", () => {
  it("utc mode contains 15:30:45 for a 15:30:45 UTC instant", () => {
    const result = formatWithTz(FIXED_MS, "utc");
    expect(result).toContain("15:30:45");
  });

  it("source mode with 'UTC' shows UTC time", () => {
    const result = formatWithTz(FIXED_MS, "source", "UTC");
    expect(result).toContain("15:30:45");
  });

  it("source mode with 'Local' returns a non-empty string without throwing", () => {
    const result = formatWithTz(FIXED_MS, "source", "Local");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("local mode returns a non-empty string", () => {
    const result = formatWithTz(FIXED_MS, "local");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

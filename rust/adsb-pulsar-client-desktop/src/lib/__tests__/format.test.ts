import { describe, it, expect, vi, afterEach } from "vitest";
import { timeAgo, formatBytes, formatWithTz } from "../format";

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

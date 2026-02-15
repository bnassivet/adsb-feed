import { describe, it, expect, vi, afterEach } from "vitest";
import { timeAgo, formatBytes } from "../format";

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

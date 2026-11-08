import { describe, it, expect } from "vitest";
import { dotTooltipHtml, formatAlt, timeAgo } from "../dot-tooltip";
import type { AircraftTrack } from "../types";

const t = (extra: Partial<AircraftTrack> = {}) =>
  ({ hex_ident: "ABC123", callsign: "ACA101", last_seen: 0, ...extra }) as AircraftTrack;

describe("formatAlt", () => {
  it("formats feet and handles missing values", () => {
    expect(formatAlt(35_000)).toBe(`${(35_000).toLocaleString()} ft`);
    expect(formatAlt(null)).toBe("N/A");
    expect(formatAlt(undefined)).toBe("N/A");
  });
});

describe("timeAgo", () => {
  it("formats seconds, minutes and hours", () => {
    const now = 10_000_000;
    expect(timeAgo(now - 5_000, now)).toBe("5s ago");
    expect(timeAgo(now - 125_000, now)).toBe("2m ago");
    expect(timeAgo(now - (2 * 3600 + 5 * 60) * 1000, now)).toBe("2h 5m ago");
  });
});

describe("dotTooltipHtml", () => {
  it("labels by callsign, falling back to hex", () => {
    expect(dotTooltipHtml("live", t(), 1000, false)).toContain("ACA101");
    expect(dotTooltipHtml("live", t({ callsign: null }), 1000, false)).toContain(">ABC123<");
  });

  it("adds the per-type details", () => {
    const now = 1_000_000;
    const hist = dotTooltipHtml("history", t({ last_seen: now - 30_000 }), 1000, true, now);
    expect(hist).toContain("Hex: ABC123");
    expect(hist).toContain("Last seen: 30s ago");
    expect(dotTooltipHtml("history", t(), 1000, false)).not.toContain("Last seen");
    expect(dotTooltipHtml("dbHistory", t(), 1000, false)).toContain("DB History");
    expect(dotTooltipHtml("imported", t(), 1000, false)).toContain("Imported");
    expect(dotTooltipHtml("live", t(), 1000, false)).not.toContain("Hex:");
    expect(dotTooltipHtml("live", t(), null, false)).toContain("N/A");
  });

  it("escapes the callsign (it comes off the air)", () => {
    const html = dotTooltipHtml("dbHistory", t({ callsign: "<img src=x>" }), 1000, false);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x&gt;");
  });
});

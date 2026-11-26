import { describe, it, expect } from "vitest";
import { dotTooltipHtml, formatAlt, openSkyWaypointTooltipHtml, rejectedTooltipHtml, timeAgo } from "../dot-tooltip";
import type { AircraftTrack, RejectedPosition } from "../types";

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

describe("rejectedTooltipHtml", () => {
  const r = (extra: Partial<RejectedPosition> = {}): RejectedPosition => ({
    hex_ident: "4CAE9A", callsign: "AFR123", latitude: 83.72, longitude: 58.21,
    altitude: 39000, timestamp_ms: 1, source_id: "dev", reason: "out_of_range",
    distance_nm: 2402.3, rejected_at_ms: 2, implied_speed_kt: null, ...extra,
  });

  it("lays out like a DB History dot: callsign, hex, altitude, then a tag", () => {
    const html = rejectedTooltipHtml(r());
    const dot = dotTooltipHtml("dbHistory", {
      hex_ident: "4CAE9A", callsign: "AFR123",
    } as AircraftTrack, 39000, false);
    // Same first three lines as the regular dot tooltip.
    expect(html.startsWith(dot.slice(0, dot.indexOf('<div style="color:#22d3ee')))).toBe(true);
    expect(html).toContain("Out of range");
    expect(html).toContain("Distance: <span style=\"color:#fff\">2402 NM</span>");
  });

  it("gives the implied speed of a speed reject, and N/A without altitude", () => {
    const html = rejectedTooltipHtml(
      r({ reason: "implausible_speed", implied_speed_kt: 39102.7, distance_nm: null, altitude: null })
    );
    expect(html).toContain("Impossible speed");
    expect(html).toContain("Speed: <span style=\"color:#fff\">39,103 kt</span>");
    expect(html).toContain("N/A");
    expect(html).not.toContain("Distance");
  });

  it("escapes the callsign (it comes off the air)", () => {
    const html = rejectedTooltipHtml(r({ callsign: "<img src=x>" }));
    expect(html).not.toContain("<img");
  });
});

describe("openSkyWaypointTooltipHtml", () => {
  it("lays out like a DB History dot, with the waypoint's time and OpenSky as the source", () => {
    const html = openSkyWaypointTooltipHtml({ hex: "3C6444", callsign: "DLH9LF" }, 31_000, 1_764_000_000);
    const dot = dotTooltipHtml("dbHistory", t({ hex_ident: "3C6444", callsign: "DLH9LF" }), 31_000, false);
    // Same head as a regular point: callsign, hex, altitude.
    expect(html.startsWith(dot.split('<div style="color:#22d3ee')[0])).toBe(true);
    expect(html).toContain(`Time: <span style="color:#fff">${new Date(1_764_000_000 * 1000).toLocaleTimeString()}</span>`);
    expect(html).toContain(">OpenSky</div>");
    expect(html).not.toContain("DB History");
  });

  it("falls back to the hex, shows a missing altitude, and escapes the callsign", () => {
    expect(openSkyWaypointTooltipHtml({ hex: "3C6444", callsign: null }, null, 1)).toContain(">3C6444<");
    expect(openSkyWaypointTooltipHtml({ hex: "3C6444", callsign: null }, null, 1)).toContain("N/A");
    expect(openSkyWaypointTooltipHtml({ hex: "3C6444", callsign: "<b>" }, 1, 1)).toContain("&lt;b&gt;");
  });
});

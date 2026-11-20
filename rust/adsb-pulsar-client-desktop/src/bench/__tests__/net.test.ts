import { describe, it, expect } from "vitest";
import { Link, NET_PROFILES, parseNet } from "../net";

describe("parseNet", () => {
  it("returns a named profile", () => {
    expect(parseNet("dsl")).toBe(NET_PROFILES.dsl);
  });

  it("treats local as no delay and no bandwidth cap", () => {
    expect(parseNet("local")).toEqual({ latencyMs: 0, mbps: null });
  });

  it("rejects an unknown name, listing the known ones", () => {
    expect(() => parseNet("5g")).toThrow(/local/);
  });

  it("orders the profiles from fast to slow", () => {
    const { broadband, dsl, mobile } = NET_PROFILES;
    expect(broadband.latencyMs).toBeLessThan(dsl.latencyMs);
    expect(dsl.latencyMs).toBeLessThan(mobile.latencyMs);
    expect(broadband.mbps!).toBeGreaterThan(dsl.mbps!);
    expect(dsl.mbps!).toBeGreaterThan(mobile.mbps!);
  });
});

describe("Link", () => {
  it("costs nothing without a bandwidth cap", () => {
    const link = new Link(null);
    expect(link.reserve(100, 1_000_000)).toBe(100);
    expect(link.reserve(100, 1_000_000)).toBe(100);
  });

  it("takes bytes × 8 / rate to send one response", () => {
    const link = new Link(8); // 8 Mbit/s = 1 MB/s = 1000 bytes per ms
    expect(link.reserve(0, 50_000)).toBe(50);
  });

  it("queues concurrent responses on the one link", () => {
    const link = new Link(8);
    expect(link.reserve(0, 10_000)).toBe(10);
    expect(link.reserve(0, 10_000)).toBe(20);
    expect(link.reserve(5, 10_000)).toBe(30);
  });

  it("starts from now once the link has gone idle", () => {
    const link = new Link(8);
    link.reserve(0, 10_000);
    expect(link.reserve(100, 10_000)).toBe(110);
  });
});

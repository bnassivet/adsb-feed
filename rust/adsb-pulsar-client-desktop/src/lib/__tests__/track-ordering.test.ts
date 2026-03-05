import { describe, it, expect } from "vitest";
import { orderTracksWithSelectedLast } from "../track-ordering";
import type { AircraftTrack } from "../types";

function makeTrack(hex: string): AircraftTrack {
  return {
    hex_ident: hex,
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
    first_seen: 0,
    last_seen: 0,
    message_count: 0,
  };
}

describe("orderTracksWithSelectedLast", () => {
  it("returns tracks unchanged when selection set is empty", () => {
    const tracks = [makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC")];
    const result = orderTracksWithSelectedLast(tracks, new Set());
    expect(result.map((t) => t.hex_ident)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("moves single selected track to last position", () => {
    const tracks = [makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC")];
    const result = orderTracksWithSelectedLast(tracks, new Set(["AAA"]));
    expect(result.map((t) => t.hex_ident)).toEqual(["BBB", "CCC", "AAA"]);
  });

  it("moves multiple selected tracks to end preserving relative order", () => {
    const tracks = [makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC"), makeTrack("DDD")];
    const result = orderTracksWithSelectedLast(tracks, new Set(["AAA", "CCC"]));
    expect(result.map((t) => t.hex_ident)).toEqual(["BBB", "DDD", "AAA", "CCC"]);
  });

  it("preserves order of non-selected tracks", () => {
    const tracks = [makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC"), makeTrack("DDD")];
    const result = orderTracksWithSelectedLast(tracks, new Set(["BBB"]));
    expect(result.map((t) => t.hex_ident)).toEqual(["AAA", "CCC", "DDD", "BBB"]);
  });

  it("returns tracks unchanged when selected not found", () => {
    const tracks = [makeTrack("AAA"), makeTrack("BBB")];
    const result = orderTracksWithSelectedLast(tracks, new Set(["ZZZ"]));
    expect(result.map((t) => t.hex_ident)).toEqual(["AAA", "BBB"]);
  });

  it("does not mutate the original array", () => {
    const tracks = [makeTrack("AAA"), makeTrack("BBB")];
    const original = [...tracks];
    orderTracksWithSelectedLast(tracks, new Set(["AAA"]));
    expect(tracks.map((t) => t.hex_ident)).toEqual(original.map((t) => t.hex_ident));
  });

  it("handles single-element array", () => {
    const tracks = [makeTrack("AAA")];
    const result = orderTracksWithSelectedLast(tracks, new Set(["AAA"]));
    expect(result.map((t) => t.hex_ident)).toEqual(["AAA"]);
  });

  it("handles empty array", () => {
    const result = orderTracksWithSelectedLast([], new Set(["AAA"]));
    expect(result).toEqual([]);
  });

  it("handles all tracks selected", () => {
    const tracks = [makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC")];
    const result = orderTracksWithSelectedLast(tracks, new Set(["AAA", "BBB", "CCC"]));
    expect(result.map((t) => t.hex_ident)).toEqual(["AAA", "BBB", "CCC"]);
  });
});

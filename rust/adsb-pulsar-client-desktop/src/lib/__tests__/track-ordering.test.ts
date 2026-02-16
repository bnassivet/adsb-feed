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
    last_seen: 0,
  };
}

describe("orderTracksWithSelectedLast", () => {
  it("returns tracks unchanged when no selection", () => {
    const tracks = [makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC")];
    const result = orderTracksWithSelectedLast(tracks, null);
    expect(result.map((t) => t.hex_ident)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("moves selected track to last position", () => {
    const tracks = [makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC")];
    const result = orderTracksWithSelectedLast(tracks, "AAA");
    expect(result.map((t) => t.hex_ident)).toEqual(["BBB", "CCC", "AAA"]);
  });

  it("preserves order of non-selected tracks", () => {
    const tracks = [makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC"), makeTrack("DDD")];
    const result = orderTracksWithSelectedLast(tracks, "BBB");
    expect(result.map((t) => t.hex_ident)).toEqual(["AAA", "CCC", "DDD", "BBB"]);
  });

  it("returns tracks unchanged when selected not found", () => {
    const tracks = [makeTrack("AAA"), makeTrack("BBB")];
    const result = orderTracksWithSelectedLast(tracks, "ZZZ");
    expect(result.map((t) => t.hex_ident)).toEqual(["AAA", "BBB"]);
  });

  it("does not mutate the original array", () => {
    const tracks = [makeTrack("AAA"), makeTrack("BBB")];
    const original = [...tracks];
    orderTracksWithSelectedLast(tracks, "AAA");
    expect(tracks.map((t) => t.hex_ident)).toEqual(original.map((t) => t.hex_ident));
  });

  it("handles single-element array", () => {
    const tracks = [makeTrack("AAA")];
    const result = orderTracksWithSelectedLast(tracks, "AAA");
    expect(result.map((t) => t.hex_ident)).toEqual(["AAA"]);
  });

  it("handles empty array", () => {
    const result = orderTracksWithSelectedLast([], "AAA");
    expect(result).toEqual([]);
  });
});

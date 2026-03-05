import { describe, it, expect } from "vitest";
import { sortTracks } from "../sort-tracks";
import type { AircraftTrack } from "../types";

function makeTrack(hex: string, overrides?: Partial<AircraftTrack>): AircraftTrack {
  return {
    hex_ident: hex,
    callsign: hex,
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
    ...overrides,
  };
}

describe("sortTracks", () => {
  it("sorts by callsign ascending", () => {
    const tracks = [makeTrack("CCC"), makeTrack("AAA"), makeTrack("BBB")];
    const result = sortTracks(tracks, "callsign", true);
    expect(result.map(t => t.hex_ident)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("sorts by callsign descending", () => {
    const tracks = [makeTrack("AAA"), makeTrack("CCC"), makeTrack("BBB")];
    const result = sortTracks(tracks, "callsign", false);
    expect(result.map(t => t.hex_ident)).toEqual(["CCC", "BBB", "AAA"]);
  });

  it("sorts by altitude ascending with nulls last", () => {
    const tracks = [
      makeTrack("A", { altitude: 30000 }),
      makeTrack("B", { altitude: null }),
      makeTrack("C", { altitude: 10000 }),
    ];
    const result = sortTracks(tracks, "altitude", true);
    expect(result.map(t => t.hex_ident)).toEqual(["C", "A", "B"]);
  });

  it("does not mutate the original array", () => {
    const tracks = [makeTrack("BBB"), makeTrack("AAA")];
    const copy = [...tracks];
    sortTracks(tracks, "callsign", true);
    expect(tracks.map(t => t.hex_ident)).toEqual(copy.map(t => t.hex_ident));
  });

  it("handles empty array", () => {
    expect(sortTracks([], "callsign", true)).toEqual([]);
  });
});

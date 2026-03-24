import { describe, it, expect } from "vitest";
import { zoomToH3Resolution, trackKey } from "../types";
import type { AircraftTrack } from "../types";

describe("zoomToH3Resolution", () => {
  it("zoom 3 returns resolution 3", () => {
    expect(zoomToH3Resolution(3)).toBe(3);
  });

  it("zoom 5 returns resolution 3 (boundary)", () => {
    expect(zoomToH3Resolution(5)).toBe(3);
  });

  it("zoom 6 returns resolution 4", () => {
    expect(zoomToH3Resolution(6)).toBe(4);
  });

  it("zoom 7 returns resolution 5", () => {
    expect(zoomToH3Resolution(7)).toBe(5);
  });

  it("zoom 9 returns resolution 6", () => {
    expect(zoomToH3Resolution(9)).toBe(6);
  });

  it("zoom 11 returns resolution 7", () => {
    expect(zoomToH3Resolution(11)).toBe(7);
  });

  it("zoom 14 returns resolution 7 (default)", () => {
    expect(zoomToH3Resolution(14)).toBe(7);
  });
});

describe("trackKey", () => {
  const base: AircraftTrack = {
    hex_ident: "ABC123",
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

  it("returns hex_ident when track_id is undefined", () => {
    expect(trackKey(base)).toBe("ABC123");
  });

  it("returns track_id when set", () => {
    expect(trackKey({ ...base, track_id: "flight-42" })).toBe("flight-42");
  });
});

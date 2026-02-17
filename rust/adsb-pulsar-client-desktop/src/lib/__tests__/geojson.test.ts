import { describe, it, expect } from "vitest";
import type { AircraftTrack } from "../types";
import { tracksToGeoJSON, geoJSONToTracks } from "../geojson";
import type { TrackFeatureCollection } from "../geojson";

/** Helper to build a minimal AircraftTrack for tests. */
function makeTrack(overrides: Partial<AircraftTrack> = {}): AircraftTrack {
  return {
    hex_ident: "AABBCC",
    callsign: "TEST123",
    altitude: 35000,
    ground_speed: 450,
    track: 180,
    latitude: 48.8566,
    longitude: 2.3522,
    vertical_rate: 0,
    squawk: "1200",
    is_on_ground: false,
    timestamp: "2025-01-15T12:00:00Z",
    positions: [
      [48.85, 2.35, 34000],
      [48.86, 2.36, 35000],
    ],
    last_seen: 1705320000000,
    message_count: 42,
    ...overrides,
  };
}

describe("tracksToGeoJSON", () => {
  it("returns a valid FeatureCollection with metadata", () => {
    const result = tracksToGeoJSON([], []);
    expect(result.type).toBe("FeatureCollection");
    expect(result.features).toEqual([]);
    expect(result.metadata.source).toBe("adsb-pulsar-client-desktop");
    expect(result.metadata.version).toBe(1);
    expect(result.metadata.track_count).toBe(0);
    expect(typeof result.metadata.exported_at).toBe("string");
  });

  it("converts a multi-position track to a LineString feature", () => {
    const track = makeTrack();
    const result = tracksToGeoJSON([track]);

    expect(result.features).toHaveLength(1);
    const feature = result.features[0];
    expect(feature.type).toBe("Feature");
    expect(feature.geometry.type).toBe("LineString");
    // GeoJSON uses [lng, lat, alt] order
    expect(feature.geometry.coordinates).toEqual([
      [2.35, 48.85, 34000],
      [2.36, 48.86, 35000],
    ]);
  });

  it("includes all track properties including last_seen", () => {
    const track = makeTrack();
    const result = tracksToGeoJSON([track]);
    const props = result.features[0].properties;

    expect(props.hex_ident).toBe("AABBCC");
    expect(props.callsign).toBe("TEST123");
    expect(props.altitude).toBe(35000);
    expect(props.ground_speed).toBe(450);
    expect(props.track).toBe(180);
    expect(props.vertical_rate).toBe(0);
    expect(props.squawk).toBe("1200");
    expect(props.is_on_ground).toBe(false);
    expect(props.timestamp).toBe("2025-01-15T12:00:00Z");
    expect(props.last_seen).toBe(1705320000000);
    expect(props.message_count).toBe(42);
  });

  it("combines active and history tracks", () => {
    const active = makeTrack({ hex_ident: "ACTIVE" });
    const hist = makeTrack({ hex_ident: "HIST01" });
    const result = tracksToGeoJSON([active], [hist]);

    expect(result.features).toHaveLength(2);
    expect(result.metadata.track_count).toBe(2);
    expect(result.features[0].properties.hex_ident).toBe("ACTIVE");
    expect(result.features[1].properties.hex_ident).toBe("HIST01");
  });

  it("handles null altitude in positions", () => {
    const track = makeTrack({
      positions: [
        [48.85, 2.35, null],
        [48.86, 2.36, 35000],
      ],
    });
    const result = tracksToGeoJSON([track]);
    const coords = result.features[0].geometry.coordinates;

    expect(coords[0]).toEqual([2.35, 48.85, null]);
    expect(coords[1]).toEqual([2.36, 48.86, 35000]);
  });

  it("handles null callsign in properties", () => {
    const track = makeTrack({ callsign: null });
    const result = tracksToGeoJSON([track]);
    expect(result.features[0].properties.callsign).toBeNull();
  });

  it("exports track with no positions as Point at [0,0] with no_position flag", () => {
    const track = makeTrack({ positions: [], latitude: null, longitude: null });
    const result = tracksToGeoJSON([track]);

    expect(result.features).toHaveLength(1);
    const feature = result.features[0];
    expect(feature.geometry.type).toBe("Point");
    expect(feature.geometry.coordinates).toEqual([0, 0]);
    expect(feature.properties.no_position).toBe(true);
  });

  it("converts single-position track to a Point feature", () => {
    const track = makeTrack({
      positions: [[48.85, 2.35, 34000]],
    });
    const result = tracksToGeoJSON([track]);

    expect(result.features).toHaveLength(1);
    const feature = result.features[0];
    expect(feature.geometry.type).toBe("Point");
    expect(feature.geometry.coordinates).toEqual([2.35, 48.85, 34000]);
  });
});

describe("geoJSONToTracks", () => {
  it("round-trips tracks through GeoJSON and back", () => {
    const original = makeTrack();
    const geojson = tracksToGeoJSON([original]);
    const result = geoJSONToTracks(geojson);

    expect(result).toHaveLength(1);
    expect(result[0].hex_ident).toBe("AABBCC");
    expect(result[0].callsign).toBe("TEST123");
    expect(result[0].altitude).toBe(35000);
    expect(result[0].last_seen).toBe(1705320000000);
    expect(result[0].message_count).toBe(42);
    // Positions should be back in [lat, lng, alt] order
    expect(result[0].positions).toEqual([
      [48.85, 2.35, 34000],
      [48.86, 2.36, 35000],
    ]);
  });

  it("handles Point features with no_position flag (empty positions)", () => {
    const track = makeTrack({ positions: [], latitude: null, longitude: null });
    const geojson = tracksToGeoJSON([track]);
    const result = geoJSONToTracks(geojson);

    expect(result).toHaveLength(1);
    expect(result[0].positions).toEqual([]);
    expect(result[0].latitude).toBeNull();
    expect(result[0].longitude).toBeNull();
  });

  it("handles single-position Point features", () => {
    const track = makeTrack({ positions: [[48.85, 2.35, 10000]] });
    const geojson = tracksToGeoJSON([track]);
    const result = geoJSONToTracks(geojson);

    expect(result).toHaveLength(1);
    expect(result[0].positions).toEqual([[48.85, 2.35, 10000]]);
    expect(result[0].latitude).toBe(48.85);
    expect(result[0].longitude).toBe(2.35);
  });

  it("skips features without hex_ident", () => {
    const geojson: TrackFeatureCollection = {
      type: "FeatureCollection",
      metadata: { exported_at: "", source: "", version: 1, track_count: 1 },
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: {
          hex_ident: "",
          callsign: null, altitude: null, ground_speed: null, track: null,
          vertical_rate: null, squawk: null, is_on_ground: null,
          timestamp: "", last_seen: 0, message_count: 0,
        },
      }],
    };
    const result = geoJSONToTracks(geojson);
    expect(result).toHaveLength(0);
  });

  it("rejects invalid JSON structure", () => {
    expect(() => geoJSONToTracks({ type: "wrong" } as unknown as TrackFeatureCollection)).toThrow(
      'Invalid GeoJSON: expected FeatureCollection, got "wrong"'
    );
  });

  it("preserves null altitude through round-trip", () => {
    const track = makeTrack({ positions: [[48.85, 2.35, null], [48.86, 2.36, 10000]] });
    const geojson = tracksToGeoJSON([track]);
    const result = geoJSONToTracks(geojson);

    expect(result[0].positions[0][2]).toBeNull();
    expect(result[0].positions[1][2]).toBe(10000);
  });
});

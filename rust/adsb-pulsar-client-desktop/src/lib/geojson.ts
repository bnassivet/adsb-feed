import type { AircraftTrack } from "./types";

/** GeoJSON coordinate: [lng, lat] or [lng, lat, altitude]. */
type GeoJSONCoordinate = [number, number] | [number, number, number | null];

/** GeoJSON Point geometry. */
interface PointGeometry {
  type: "Point";
  coordinates: GeoJSONCoordinate;
}

/** GeoJSON LineString geometry. */
interface LineStringGeometry {
  type: "LineString";
  coordinates: GeoJSONCoordinate[];
}

/** Properties stored on each GeoJSON feature (from AircraftTrack). */
export interface TrackProperties {
  hex_ident: string;
  callsign: string | null;
  altitude: number | null;
  ground_speed: number | null;
  track: number | null;
  vertical_rate: number | null;
  squawk: string | null;
  is_on_ground: boolean | null;
  timestamp: string;
  last_seen: number;
  message_count: number;
  no_position?: boolean;
}

/** A GeoJSON Feature representing a single aircraft track. */
export interface TrackFeature {
  type: "Feature";
  geometry: PointGeometry | LineStringGeometry;
  properties: TrackProperties;
}

/** Export metadata attached to the FeatureCollection. */
export interface ExportMetadata {
  exported_at: string;
  track_count: number;
  source: string;
  version: number;
}

/** GeoJSON FeatureCollection with export metadata. */
export interface TrackFeatureCollection {
  type: "FeatureCollection";
  metadata: ExportMetadata;
  features: TrackFeature[];
}

/**
 * Convert an internal position tuple [lat, lng, alt|null] to GeoJSON [lng, lat, alt].
 */
function positionToCoordinate(
  pos: [number, number, number | null],
): GeoJSONCoordinate {
  const [lat, lng, alt] = pos;
  return [lng, lat, alt];
}

/**
 * Convert a GeoJSON coordinate [lng, lat, alt?] back to internal [lat, lng, alt|null].
 */
function coordinateToPosition(
  coord: GeoJSONCoordinate,
): [number, number, number | null] {
  const [lng, lat] = coord;
  const alt = coord.length >= 3 ? (coord[2] as number | null) : null;
  return [lat, lng, alt];
}

/**
 * Convert active and history AircraftTrack arrays to a GeoJSON FeatureCollection.
 *
 * - Tracks with no positions become Point at [0, 0] with no_position flag.
 * - Single-position tracks become Point features.
 * - Multi-position tracks become LineString features.
 * - Positions use GeoJSON coordinate order: [longitude, latitude, altitude].
 */
export function tracksToGeoJSON(
  activeTracks: AircraftTrack[],
  historyTracks: AircraftTrack[] = [],
): TrackFeatureCollection {
  const allTracks = [...activeTracks, ...historyTracks];

  const features: TrackFeature[] = allTracks.map(trackToFeature);

  return {
    type: "FeatureCollection",
    metadata: {
      exported_at: new Date().toISOString(),
      track_count: features.length,
      source: "adsb-pulsar-client-desktop",
      version: 1,
    },
    features,
  };
}

function trackToFeature(t: AircraftTrack): TrackFeature {
  const properties: TrackProperties = {
    hex_ident: t.hex_ident,
    callsign: t.callsign,
    altitude: t.altitude,
    ground_speed: t.ground_speed,
    track: t.track,
    vertical_rate: t.vertical_rate,
    squawk: t.squawk,
    is_on_ground: t.is_on_ground,
    timestamp: t.timestamp,
    last_seen: t.last_seen,
    message_count: t.message_count,
  };

  if (t.positions.length === 0) {
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { ...properties, no_position: true },
    };
  }

  if (t.positions.length === 1) {
    return {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: positionToCoordinate(t.positions[0]),
      },
      properties,
    };
  }

  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: t.positions.map(positionToCoordinate),
    },
    properties,
  };
}

/**
 * Parse a GeoJSON FeatureCollection back into AircraftTrack[].
 * Skips features without a hex_ident. Throws on invalid GeoJSON structure.
 */
export function geoJSONToTracks(geojson: TrackFeatureCollection): AircraftTrack[] {
  if (geojson.type !== "FeatureCollection") {
    throw new Error(`Invalid GeoJSON: expected FeatureCollection, got "${geojson.type}"`);
  }

  const tracks: AircraftTrack[] = [];

  for (const feature of geojson.features) {
    const props = feature.properties;
    if (!props.hex_ident) continue;

    let positions: [number, number, number | null][] = [];

    if (feature.geometry.type === "LineString") {
      positions = feature.geometry.coordinates.map(coordinateToPosition);
    } else if (feature.geometry.type === "Point" && !props.no_position) {
      positions = [coordinateToPosition(feature.geometry.coordinates)];
    }
    // Point with no_position: positions stays []

    tracks.push({
      hex_ident: props.hex_ident,
      callsign: props.callsign,
      altitude: props.altitude,
      ground_speed: props.ground_speed,
      track: props.track,
      latitude: positions.length > 0 ? positions[positions.length - 1][0] : null,
      longitude: positions.length > 0 ? positions[positions.length - 1][1] : null,
      vertical_rate: props.vertical_rate,
      squawk: props.squawk,
      is_on_ground: props.is_on_ground,
      timestamp: props.timestamp,
      positions,
      last_seen: props.last_seen,
      message_count: props.message_count,
    });
  }

  return tracks;
}

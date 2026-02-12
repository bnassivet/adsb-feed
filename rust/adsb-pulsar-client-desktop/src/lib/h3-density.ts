import { latLngToCell, cellToBoundary } from "h3-js";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { AircraftTrack, DensityMetric } from "@/lib/types";

interface CellAgg {
  count: number;
  aircraft: Set<string>;
  altitudeSum: number;
  altitudeCount: number;
}

export interface DensityProperties {
  cell: string;
  value: number;
  normalized: number;
}

/**
 * Converts aircraft tracks into an H3 hex density GeoJSON FeatureCollection.
 *
 * Each hex polygon carries a `value` (raw count) and `normalized` (0-1) property
 * suitable for driving a color scale.
 */
export function computeH3Density(
  tracks: AircraftTrack[],
  metric: DensityMetric,
  resolution: number,
): FeatureCollection<Polygon, DensityProperties> {
  // Aggregate positions into H3 cells
  const cells = new Map<string, CellAgg>();

  for (const track of tracks) {
    for (const [lat, lng] of track.positions) {
      const cell = latLngToCell(lat, lng, resolution);
      let agg = cells.get(cell);
      if (!agg) {
        agg = { count: 0, aircraft: new Set(), altitudeSum: 0, altitudeCount: 0 };
        cells.set(cell, agg);
      }
      agg.count++;
      agg.aircraft.add(track.hex_ident);
      if (track.altitude !== null) {
        agg.altitudeSum += track.altitude;
        agg.altitudeCount++;
      }
    }
  }

  // Extract value per cell based on metric
  function cellValue(agg: CellAgg): number {
    if (metric === "positions") return agg.count;
    if (metric === "aircraft") return agg.aircraft.size;
    // altitude: mean altitude in feet (0 if no altitude data)
    return agg.altitudeCount > 0 ? agg.altitudeSum / agg.altitudeCount : 0;
  }

  // Find max for normalization (altitude uses fixed 0-50000 ft range)
  let max = 0;
  if (metric === "altitude") {
    max = 50000;
  } else {
    for (const agg of cells.values()) {
      const val = cellValue(agg);
      if (val > max) max = val;
    }
  }

  // Build GeoJSON features
  const features: Feature<Polygon, DensityProperties>[] = [];

  for (const [cell, agg] of cells) {
    const value = cellValue(agg);
    const normalized = max > 0 ? value / max : 0;

    // cellToBoundary returns [lat, lng][] — swap to [lng, lat][] for GeoJSON
    const boundary = cellToBoundary(cell);
    const ring = boundary.map(([lat, lng]) => [lng, lat] as [number, number]);
    // Close the ring (GeoJSON spec requires first === last)
    ring.push(ring[0]);

    features.push({
      type: "Feature",
      properties: { cell, value, normalized },
      geometry: {
        type: "Polygon",
        coordinates: [ring],
      },
    });
  }

  return { type: "FeatureCollection", features };
}

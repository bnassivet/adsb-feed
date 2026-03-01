import { latLngToCell, cellToBoundary } from "h3-js";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { AircraftTrack, DensityMetric } from "@/lib/types";

interface CellAgg {
  count: number;
  aircraft: Set<string>;
  altitudeSum: number;
  altitudeCount: number;
  altitudeMin: number;
  altitudeMax: number;
}

export interface DensityProperties {
  cell: string;
  value: number;
  normalized: number;
}

export interface DensityAltitudeRange {
  altitudeMin: number;
  altitudeMax: number;
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
  altitudeRange?: DensityAltitudeRange,
): FeatureCollection<Polygon, DensityProperties> {
  // Aggregate positions into H3 cells
  const cells = new Map<string, CellAgg>();

  for (const track of tracks) {
    for (const [lat, lng, alt] of track.positions) {
      // Filter by altitude range if specified
      if (altitudeRange) {
        if (alt == null || alt < altitudeRange.altitudeMin || alt > altitudeRange.altitudeMax) {
          continue;
        }
      }

      const cell = latLngToCell(lat, lng, resolution);
      let agg = cells.get(cell);
      if (!agg) {
        agg = { count: 0, aircraft: new Set(), altitudeSum: 0, altitudeCount: 0, altitudeMin: Infinity, altitudeMax: -Infinity };
        cells.set(cell, agg);
      }
      agg.count++;
      agg.aircraft.add(track.hex_ident);
      if (alt !== null && alt !== undefined) {
        agg.altitudeSum += alt;
        agg.altitudeCount++;
        if (alt < agg.altitudeMin) agg.altitudeMin = alt;
        if (alt > agg.altitudeMax) agg.altitudeMax = alt;
      }
    }
  }

  // Extract value per cell based on metric
  function cellValue(agg: CellAgg): number {
    if (metric === "positions") return agg.count;
    if (metric === "aircraft") return agg.aircraft.size;
    if (metric === "altitude_min") return agg.altitudeCount > 0 ? agg.altitudeMin : 0;
    if (metric === "altitude_max") return agg.altitudeCount > 0 ? agg.altitudeMax : 0;
    // altitude: mean altitude in feet (0 if no altitude data)
    return agg.altitudeCount > 0 ? agg.altitudeSum / agg.altitudeCount : 0;
  }

  // Find max for normalization (altitude metrics use fixed 0-50000 ft range)
  let max = 0;
  if (metric === "altitude" || metric === "altitude_min" || metric === "altitude_max") {
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

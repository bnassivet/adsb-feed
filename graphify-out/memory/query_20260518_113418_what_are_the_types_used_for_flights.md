---
type: "query"
date: "2026-05-18T11:34:18.792503+00:00"
question: "what are the types used for flights?"
contributor: "graphify"
source_nodes: ["AircraftTrack", "FlightSummary", "AircraftSummary", "ActiveFlight", "AircraftPosition", "TimeGranularity", "TimeDistributionBucket", "HourlyHeatmapCell", "DetectionRangeSector", "StorageStats"]
---

# Q: what are the types used for flights?

## Answer

The flight-related types span TypeScript and Rust layers. TypeScript (src/lib/types.ts): AircraftTrack (L61, real-time tracking), FlightSummary (L260, historical query result), AircraftSummary (L249, aggregated aircraft data), TimeGranularity (L166, query granularity enum), TimeDistributionBucket (L281, time-based analytics), HourlyHeatmapCell (L328, analytics aggregation), DetectionRangeSector (L306, radar sector data), StorageStats (L375, DuckDB storage stats). Rust (adsb-data-engine/src/): AircraftPosition (sbs_parser.rs, raw SBS-1 parsed position), ActiveFlight (storage.rs, in-progress flight), AircraftSummary (types.rs), BboxQuery, CreateEventOfInterest, DetectionRangeQuery.

## Source Nodes

- AircraftTrack
- FlightSummary
- AircraftSummary
- ActiveFlight
- AircraftPosition
- TimeGranularity
- TimeDistributionBucket
- HourlyHeatmapCell
- DetectionRangeSector
- StorageStats
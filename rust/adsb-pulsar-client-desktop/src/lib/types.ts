/** Aircraft position from a single SBS-1 message (mirrors Rust AircraftPosition). */
export interface AircraftPosition {
  hex_ident: string;
  callsign: string | null;
  altitude: number | null;
  ground_speed: number | null;
  track: number | null;
  latitude: number | null;
  longitude: number | null;
  vertical_rate: number | null;
  squawk: string | null;
  is_on_ground: boolean | null;
  timestamp: string;
  message_count: number;
}

/** Accumulated track state for a single aircraft (built from multiple positions). */
export interface AircraftTrack {
  hex_ident: string;
  callsign: string | null;
  altitude: number | null;
  ground_speed: number | null;
  track: number | null;
  latitude: number | null;
  longitude: number | null;
  vertical_rate: number | null;
  squawk: string | null;
  is_on_ground: boolean | null;
  timestamp: string;
  /** Position history for trajectory line drawing: [lat, lng, altitude | null] */
  positions: [number, number, number | null][];
  /** Time of first detection (ms since epoch). Set once, never updated. */
  first_seen: number;
  /** Last update time for TTL expiry */
  last_seen: number;
  /** Total SBS-1 messages received for this aircraft (pre-throttle cumulative count). */
  message_count: number;
}

/** Metrics snapshot from the Rust backend (mirrors MetricsSnapshot). */
export interface MetricsSnapshot {
  messages_sent: number;
  errors: number;
  bytes_received: number;
  bytes_sent: number;
  retry_queue_size: number;
  elapsed_secs: number;
  throughput_msg_per_sec: number;
}

/** Connection status (mirrors Rust ConnectionStatus). */
export type ConnectionStatus =
  | { status: "Disconnected" }
  | { status: "Connecting" }
  | { status: "Connected" }
  | { status: "Degraded" }
  | { status: "ConnectionLost" }
  | { status: "Error"; message: string };

/** Status response from get_status command. */
export interface StatusResponse {
  is_running: boolean;
  socket_status: ConnectionStatus;
  pulsar_status: ConnectionStatus;
}

/** Client configuration (mirrors Rust Config). */
export interface Config {
  source_id: string;
  socket_host: string;
  socket_port: number;
  pulsar_broker: string;
  pulsar_topic: string;
  recv_buffer_size: number;
  socket_timeout_secs: number;
  socket_read_timeout_secs: number;
  initial_retry_delay_secs: number;
  max_retry_delay_secs: number;
  log_sample_rate: number;
  max_retry_queue_size: number;
  max_line_buffer_size: number;
  pulsar_batch_delay_ms: number;
  pulsar_batch_max_messages: number;
  test_mode: boolean;
  log_level: string;
  connection_mode: string;
  dump1090_tz: string;
  receiver_latitude: number | null;
  receiver_longitude: number | null;
  receiver_altitude: number | null;
}

/** Filter state for the UI. */
export interface Filters {
  /** Raw input string; may contain comma-separated tokens for multi-ID filtering. */
  callsign: string;
  altitudeMin: number;
  altitudeMax: number;
  speedMin: number;
  speedMax: number;
  /** When true, the callsign/hex filter is also applied to imported tracks. */
  includeImportedInFilter: boolean;
}

/** Quick-select time range for DB History queries. */
export type TimeRangePreset = "24h" | "48h" | "1w" | "2w" | "1m" | "3m" | "custom";

/** Granularity for the time distribution histogram buckets. */
export type TimeGranularity = "1h" | "4h" | "day" | "week" | "month";

/** Which metric the H3 density overlay displays. */
export type DensityMetric = "positions" | "aircraft" | "altitude" | "altitude_min" | "altitude_max";

/** Tooltip detail level for the H3 density overlay. */
export type DensityTooltipMode = "compact" | "extended";

/** How trajectory positions are colored: by each position's altitude or the track's latest altitude. */
export type AltitudeColorMode = "plot" | "track";

/** Maps a Leaflet zoom level to the appropriate H3 resolution. */
export function zoomToH3Resolution(zoom: number): number {
  if (zoom <= 5) return 3;
  if (zoom === 6) return 4;
  if (zoom === 7) return 5;
  if (zoom <= 9) return 6;
  if (zoom <= 11) return 7;
  if (zoom <= 13) return 8;
  return 7;
}

// --- Historical query types (mirrors Rust adsb-data-engine types) ---

/** Row returned from DuckDB historical queries. */
export interface PositionRecord {
  hex_ident: string;
  callsign: string | null;
  latitude: number;
  longitude: number;
  altitude: number | null;
  ground_speed: number | null;
  track: number | null;
  vertical_rate: number | null;
  squawk: string | null;
  is_on_ground: boolean | null;
  timestamp_ms: number;
}

/** Bounding box + time window query parameters. */
export interface BboxQuery {
  north: number;
  south: number;
  east: number;
  west: number;
  start_ms?: number | null;
  end_ms?: number | null;
  limit: number;
}

/** Single-aircraft trajectory query. */
export interface TrajectoryQuery {
  hex_ident: string;
  start_ms?: number | null;
  end_ms?: number | null;
}

/** Summary of a single aircraft within a time window. */
export interface AircraftSummary {
  hex_ident: string;
  callsign: string | null;
  position_count: number;
  first_seen_ms: number;
  last_seen_ms: number;
  min_altitude: number | null;
  max_altitude: number | null;
}

/** A single bucket in a time distribution histogram. */
export interface TimeDistributionBucket {
  bucket_ms: number;
  count: number;
}

/** Query parameters for time distribution (histogram). */
export interface TimeDistributionQuery {
  start_ms: number;
  end_ms: number;
  num_buckets: number;
}

/** Query parameters for detection range analysis. */
export interface DetectionRangeQuery {
  receiver_lat: number;
  receiver_lon: number;
  start_ms?: number | null;
  end_ms?: number | null;
}

/** A single 10° azimuth sector in the detection range result. */
export interface DetectionRangeSector {
  /** Center bearing: 0, 10, 20, ..., 350. */
  bearing_deg: number;
  /** Maximum distance detected in this sector (nautical miles). */
  max_distance_nm: number;
  /** Number of positions observed in this sector. */
  position_count: number;
  /** Minimum altitude observed in this sector (feet), or null if no altitude data. */
  min_altitude: number | null;
  /** Maximum altitude observed in this sector (feet), or null if no altitude data. */
  max_altitude: number | null;
}

/** Query parameters for hourly activity heatmap. */
export interface HourlyHeatmapQuery {
  start_ms: number;
  end_ms: number;
}

/** A single cell in the hourly activity heatmap (one day × one hour). */
export interface HourlyHeatmapCell {
  /** Midnight epoch ms of the calendar day (UTC). */
  day_ms: number;
  /** Hour of day (0–23). */
  hour: number;
  /** Number of distinct aircraft seen in this cell. */
  aircraft_count: number;
  /** Total number of position messages in this cell. */
  message_count: number;
}

/** Which metric the activity heatmap displays. */
export type HeatmapMetric = "aircraft" | "messages";

/** Storage statistics. */
export interface StorageStats {
  row_count: number;
  db_size_bytes: number;
  oldest_timestamp_ms: number | null;
  newest_timestamp_ms: number | null;
}

export const DEFAULT_FILTERS: Filters = {
  callsign: "",
  altitudeMin: 0,
  altitudeMax: 50000,
  speedMin: 0,
  speedMax: 600,
  includeImportedInFilter: false,
};

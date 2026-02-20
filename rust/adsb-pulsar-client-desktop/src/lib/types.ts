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
}

/** Filter state for the UI. */
export interface Filters {
  callsign: string;
  altitudeMin: number;
  altitudeMax: number;
  speedMin: number;
  speedMax: number;
}

/** Which metric the H3 density overlay displays. */
export type DensityMetric = "positions" | "aircraft" | "altitude";

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

export const DEFAULT_FILTERS: Filters = {
  callsign: "",
  altitudeMin: 0,
  altitudeMax: 50000,
  speedMin: 0,
  speedMax: 600,
};

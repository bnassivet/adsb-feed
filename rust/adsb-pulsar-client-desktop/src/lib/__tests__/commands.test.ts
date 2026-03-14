import { describe, it, expect, beforeEach } from "vitest";
import {
  mockInvokeResponse,
  clearMockResponses,
} from "@/test/mocks/tauri";
import {
  queryBbox,
  getTrajectory,
  getAircraftSummary,
  getTimeDistribution,
  getStorageStats,
  getDetectionRange,
  getRecordingState,
  setRecordingState,
} from "../commands";
import type {
  BboxQuery,
  TrajectoryQuery,
  PositionRecord,
  AircraftSummary,
  RecordingState,
  StorageStats,
  TimeDistributionBucket,
  TimeDistributionQuery,
  DetectionRangeQuery,
  DetectionRangeSector,
} from "../types";

const samplePosition: PositionRecord = {
  hex_ident: "A1B2C3",
  callsign: "TEST123",
  latitude: 45.5,
  longitude: -73.5,
  altitude: 35000,
  ground_speed: 450,
  track: 90,
  vertical_rate: 0,
  squawk: "1200",
  is_on_ground: false,
  timestamp_ms: 1705315800000,
};

const sampleSummary: AircraftSummary = {
  hex_ident: "A1B2C3",
  callsign: "TEST123",
  position_count: 42,
  first_seen_ms: 1705315800000,
  last_seen_ms: 1705316100000,
  min_altitude: 30000,
  max_altitude: 35000,
};

const sampleStats: StorageStats = {
  row_count: 1000,
  db_size_bytes: 1128000,
  oldest_timestamp_ms: 1705315800000,
  newest_timestamp_ms: 1705316100000,
  raw_message_count: 5000,
  raw_db_size_bytes: 1000000,
};

describe("Historical query commands", () => {
  beforeEach(() => {
    clearMockResponses();
  });

  describe("queryBbox", () => {
    it("sends query params and returns position records", async () => {
      mockInvokeResponse("query_bbox", [samplePosition]);

      const query: BboxQuery = {
        north: 47,
        south: 45,
        east: -72,
        west: -75,
        limit: 100,
      };

      const result = await queryBbox(query);
      expect(result).toEqual([samplePosition]);
    });

    it("returns empty array for no matches", async () => {
      mockInvokeResponse("query_bbox", []);

      const result = await queryBbox({
        north: 0,
        south: -1,
        east: 0,
        west: -1,
        limit: 100,
      });
      expect(result).toEqual([]);
    });
  });

  describe("getTrajectory", () => {
    it("returns ordered positions for a single aircraft", async () => {
      const pos2 = { ...samplePosition, timestamp_ms: 1705315860000 };
      mockInvokeResponse("get_trajectory", [samplePosition, pos2]);

      const query: TrajectoryQuery = { hex_ident: "A1B2C3" };
      const result = await getTrajectory(query);

      expect(result).toHaveLength(2);
      expect(result[0].timestamp_ms).toBeLessThan(result[1].timestamp_ms);
    });

    it("supports time window parameters", async () => {
      mockInvokeResponse("get_trajectory", [samplePosition]);

      const query: TrajectoryQuery = {
        hex_ident: "A1B2C3",
        start_ms: 1705315000000,
        end_ms: 1705316000000,
      };
      const result = await getTrajectory(query);
      expect(result).toHaveLength(1);
    });
  });

  describe("getAircraftSummary", () => {
    it("returns aircraft summaries", async () => {
      mockInvokeResponse("get_aircraft_summary", [sampleSummary]);

      const result = await getAircraftSummary();
      expect(result).toEqual([sampleSummary]);
      expect(result[0].position_count).toBe(42);
    });

    it("accepts time window parameters", async () => {
      mockInvokeResponse("get_aircraft_summary", [sampleSummary]);

      const result = await getAircraftSummary(1705315000000, 1705316000000);
      expect(result).toHaveLength(1);
    });
  });

  describe("getTimeDistribution", () => {
    it("sends query and returns buckets", async () => {
      const buckets: TimeDistributionBucket[] = [
        { bucket_ms: 1705315800000, count: 5 },
        { bucket_ms: 1705315860000, count: 3 },
      ];
      mockInvokeResponse("get_time_distribution", buckets);

      const query: TimeDistributionQuery = {
        start_ms: 1705315800000,
        end_ms: 1705316100000,
        num_buckets: 24,
      };

      const result = await getTimeDistribution(query);
      expect(result).toHaveLength(2);
      expect(result[0].bucket_ms).toBe(1705315800000);
      expect(result[0].count).toBe(5);
    });

    it("returns empty array for no data", async () => {
      mockInvokeResponse("get_time_distribution", []);

      const result = await getTimeDistribution({
        start_ms: 0,
        end_ms: 1000,
        num_buckets: 10,
      });
      expect(result).toEqual([]);
    });
  });

  describe("getStorageStats", () => {
    it("returns storage statistics", async () => {
      mockInvokeResponse("get_storage_stats", sampleStats);

      const result = await getStorageStats();
      expect(result.row_count).toBe(1000);
      expect(result.db_size_bytes).toBe(1128000);
      expect(result.oldest_timestamp_ms).toBe(1705315800000);
      expect(result.newest_timestamp_ms).toBe(1705316100000);
    });
  });

  describe("getDetectionRange", () => {
    it("sends query params and returns sectors", async () => {
      const sectors: DetectionRangeSector[] = [
        { bearing_deg: 0, max_distance_nm: 120.5, position_count: 42, min_altitude: 1000, max_altitude: 40000 },
        { bearing_deg: 90, max_distance_nm: 85.2, position_count: 18, min_altitude: null, max_altitude: null },
      ];
      mockInvokeResponse("get_detection_range", sectors);

      const query: DetectionRangeQuery = {
        receiver_lat: 45.5,
        receiver_lon: -73.5,
        start_ms: 1705315800000,
        end_ms: 1705316100000,
      };

      const result = await getDetectionRange(query);
      expect(result).toHaveLength(2);
      expect(result[0].bearing_deg).toBe(0);
      expect(result[0].max_distance_nm).toBe(120.5);
      expect(result[0].position_count).toBe(42);
    });

    it("returns empty array for no data", async () => {
      mockInvokeResponse("get_detection_range", []);

      const result = await getDetectionRange({
        receiver_lat: 0,
        receiver_lon: 0,
      });
      expect(result).toEqual([]);
    });
  });

  describe("getRecordingState", () => {
    it("returns the current recording state", async () => {
      const state: RecordingState = { record_positions: true, record_raw: false };
      mockInvokeResponse("get_recording_state", state);

      const result = await getRecordingState();
      expect(result.record_positions).toBe(true);
      expect(result.record_raw).toBe(false);
    });
  });

  describe("setRecordingState", () => {
    it("sends recording state to backend", async () => {
      mockInvokeResponse("set_recording_state", undefined);

      await expect(
        setRecordingState({ record_positions: false, record_raw: true })
      ).resolves.toBeUndefined();
    });
  });
});

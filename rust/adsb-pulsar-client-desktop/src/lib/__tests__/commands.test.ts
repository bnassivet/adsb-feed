import { describe, it, expect, beforeEach } from "vitest";
import {
  mockInvokeResponse,
  clearMockResponses,
} from "@/test/mocks/tauri";
import {
  queryBbox,
  getTrajectory,
  getAircraftSummary,
  getStorageStats,
} from "../commands";
import type {
  BboxQuery,
  TrajectoryQuery,
  PositionRecord,
  AircraftSummary,
  StorageStats,
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
  db_size_bytes: 128000,
  oldest_timestamp_ms: 1705315800000,
  newest_timestamp_ms: 1705316100000,
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

  describe("getStorageStats", () => {
    it("returns storage statistics", async () => {
      mockInvokeResponse("get_storage_stats", sampleStats);

      const result = await getStorageStats();
      expect(result.row_count).toBe(1000);
      expect(result.db_size_bytes).toBe(128000);
      expect(result.oldest_timestamp_ms).toBe(1705315800000);
      expect(result.newest_timestamp_ms).toBe(1705316100000);
    });
  });
});

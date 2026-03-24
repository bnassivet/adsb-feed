import { describe, it, expect } from "vitest";
import {
  browseReducer,
  initialBrowseState,
  type BrowseState,
} from "../browse-reducer";
import type { FlightSummary } from "../types";

const flight1: FlightSummary = {
  hex_ident: "A1B2C3",
  flight_num: 0,
  flight_id: "A1B2C3_0",
  callsign: "TEST1",
  position_count: 42,
  first_seen_ms: 1000,
  last_seen_ms: 2000,
  min_altitude: 30000,
  max_altitude: 35000,
};

const flight2: FlightSummary = {
  hex_ident: "D4E5F6",
  flight_num: 0,
  flight_id: "D4E5F6_0",
  callsign: "TEST2",
  position_count: 10,
  first_seen_ms: 3000,
  last_seen_ms: 4000,
  min_altitude: 20000,
  max_altitude: 25000,
};

describe("browseReducer", () => {
  describe("START_BROWSE", () => {
    it("sets browsing and loading to true", () => {
      const next = browseReducer(initialBrowseState, { type: "START_BROWSE" });
      expect(next.browsing).toBe(true);
      expect(next.loading).toBe(true);
    });

    it("preserves existing state fields", () => {
      const state: BrowseState = {
        ...initialBrowseState,
        summaries: [{ hex_ident: "X", callsign: null, position_count: 1, first_seen_ms: 0, last_seen_ms: 0, min_altitude: null, max_altitude: null }],
      };
      const next = browseReducer(state, { type: "START_BROWSE" });
      expect(next.summaries).toHaveLength(1);
    });
  });

  describe("BROWSE_RESULTS", () => {
    it("sets all result fields and clears loading and selection", () => {
      const state: BrowseState = {
        ...initialBrowseState,
        loading: true,
        selectedFlights: new Set(["old"]),
      };

      const next = browseReducer(state, {
        type: "BROWSE_RESULTS",
        summaries: [],
        flightSummaries: [flight1, flight2],
        timeBuckets: [],
        detectionSectors: [],
        heatmapCells: [],
        rawMessageCount: 99,
      });

      expect(next.loading).toBe(false);
      expect(next.browsing).toBe(true);
      expect(next.flightSummaries).toEqual([flight1, flight2]);
      expect(next.rawMessageCount).toBe(99);
      expect(next.selectedFlights.size).toBe(0);
    });
  });

  describe("TOGGLE_FLIGHT", () => {
    it("adds flight to selection when not present", () => {
      const state: BrowseState = {
        ...initialBrowseState,
        flightSummaries: [flight1, flight2],
        selectedFlights: new Set(),
      };
      const next = browseReducer(state, {
        type: "TOGGLE_FLIGHT",
        flightId: "A1B2C3_0",
      });
      expect(next.selectedFlights.has("A1B2C3_0")).toBe(true);
      expect(next.selectedFlights.size).toBe(1);
    });

    it("removes flight from selection when already present", () => {
      const state: BrowseState = {
        ...initialBrowseState,
        flightSummaries: [flight1, flight2],
        selectedFlights: new Set(["A1B2C3_0", "D4E5F6_0"]),
      };
      const next = browseReducer(state, {
        type: "TOGGLE_FLIGHT",
        flightId: "A1B2C3_0",
      });
      expect(next.selectedFlights.has("A1B2C3_0")).toBe(false);
      expect(next.selectedFlights.has("D4E5F6_0")).toBe(true);
    });

    it("does not mutate original set", () => {
      const original = new Set(["A1B2C3_0"]);
      const state: BrowseState = {
        ...initialBrowseState,
        selectedFlights: original,
      };
      browseReducer(state, { type: "TOGGLE_FLIGHT", flightId: "D4E5F6_0" });
      expect(original.size).toBe(1);
    });
  });

  describe("TOGGLE_ALL", () => {
    it("selects all when none selected", () => {
      const state: BrowseState = {
        ...initialBrowseState,
        flightSummaries: [flight1, flight2],
        selectedFlights: new Set(),
      };
      const next = browseReducer(state, { type: "TOGGLE_ALL" });
      expect(next.selectedFlights.size).toBe(2);
      expect(next.selectedFlights.has("A1B2C3_0")).toBe(true);
      expect(next.selectedFlights.has("D4E5F6_0")).toBe(true);
    });

    it("deselects all when all selected", () => {
      const state: BrowseState = {
        ...initialBrowseState,
        flightSummaries: [flight1, flight2],
        selectedFlights: new Set(["A1B2C3_0", "D4E5F6_0"]),
      };
      const next = browseReducer(state, { type: "TOGGLE_ALL" });
      expect(next.selectedFlights.size).toBe(0);
    });

    it("selects all when partially selected", () => {
      const state: BrowseState = {
        ...initialBrowseState,
        flightSummaries: [flight1, flight2],
        selectedFlights: new Set(["A1B2C3_0"]),
      };
      const next = browseReducer(state, { type: "TOGGLE_ALL" });
      expect(next.selectedFlights.size).toBe(2);
    });
  });

  describe("CLEAR_SELECTION", () => {
    it("empties selectedFlights", () => {
      const state: BrowseState = {
        ...initialBrowseState,
        selectedFlights: new Set(["A1B2C3_0"]),
      };
      const next = browseReducer(state, { type: "CLEAR_SELECTION" });
      expect(next.selectedFlights.size).toBe(0);
    });
  });

  describe("SET_BATCH_LOADING", () => {
    it("sets batchLoading to true", () => {
      const next = browseReducer(initialBrowseState, {
        type: "SET_BATCH_LOADING",
        loading: true,
      });
      expect(next.batchLoading).toBe(true);
    });

    it("sets batchLoading to false", () => {
      const state = { ...initialBrowseState, batchLoading: true };
      const next = browseReducer(state, {
        type: "SET_BATCH_LOADING",
        loading: false,
      });
      expect(next.batchLoading).toBe(false);
    });
  });

  describe("initial state", () => {
    it("has expected defaults", () => {
      expect(initialBrowseState.browsing).toBe(false);
      expect(initialBrowseState.loading).toBe(false);
      expect(initialBrowseState.batchLoading).toBe(false);
      expect(initialBrowseState.flightSummaries).toEqual([]);
      expect(initialBrowseState.selectedFlights.size).toBe(0);
      expect(initialBrowseState.rawMessageCount).toBe(0);
    });
  });
});

import type {
  AircraftSummary,
  DetectionRangeSector,
  FlightSummary,
  HourlyHeatmapCell,
  TimeDistributionBucket,
} from "./types";

export interface BrowseState {
  browsing: boolean;
  loading: boolean;
  batchLoading: boolean;
  summaries: AircraftSummary[];
  flightSummaries: FlightSummary[];
  timeBuckets: TimeDistributionBucket[];
  detectionSectors: DetectionRangeSector[];
  heatmapCells: HourlyHeatmapCell[];
  rawMessageCount: number;
  selectedFlights: Set<string>;
}

export type BrowseAction =
  | { type: "START_BROWSE" }
  | {
      type: "BROWSE_RESULTS";
      summaries: AircraftSummary[];
      flightSummaries: FlightSummary[];
      timeBuckets: TimeDistributionBucket[];
      detectionSectors: DetectionRangeSector[];
      heatmapCells: HourlyHeatmapCell[];
      rawMessageCount: number;
    }
  | { type: "TOGGLE_FLIGHT"; flightId: string }
  | { type: "TOGGLE_ALL" }
  | { type: "CLEAR_SELECTION" }
  | { type: "SET_BATCH_LOADING"; loading: boolean };

export const initialBrowseState: BrowseState = {
  browsing: false,
  loading: false,
  batchLoading: false,
  summaries: [],
  flightSummaries: [],
  timeBuckets: [],
  detectionSectors: [],
  heatmapCells: [],
  rawMessageCount: 0,
  selectedFlights: new Set(),
};

export function browseReducer(
  state: BrowseState,
  action: BrowseAction,
): BrowseState {
  switch (action.type) {
    case "START_BROWSE":
      return { ...state, browsing: true, loading: true };

    case "BROWSE_RESULTS":
      return {
        ...state,
        loading: false,
        browsing: true,
        summaries: action.summaries,
        flightSummaries: action.flightSummaries,
        timeBuckets: action.timeBuckets,
        detectionSectors: action.detectionSectors,
        heatmapCells: action.heatmapCells,
        rawMessageCount: action.rawMessageCount,
        selectedFlights: new Set(),
      };

    case "TOGGLE_FLIGHT": {
      const next = new Set(state.selectedFlights);
      if (next.has(action.flightId)) next.delete(action.flightId);
      else next.add(action.flightId);
      return { ...state, selectedFlights: next };
    }

    case "TOGGLE_ALL": {
      if (state.selectedFlights.size === state.flightSummaries.length) {
        return { ...state, selectedFlights: new Set() };
      }
      return {
        ...state,
        selectedFlights: new Set(
          state.flightSummaries.map((f) => f.flight_id),
        ),
      };
    }

    case "CLEAR_SELECTION":
      return { ...state, selectedFlights: new Set() };

    case "SET_BATCH_LOADING":
      return { ...state, batchLoading: action.loading };

    default:
      return state;
  }
}

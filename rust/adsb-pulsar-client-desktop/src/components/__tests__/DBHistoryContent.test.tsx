import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import { DBHistoryContent } from "../DBHistoryContent";
import type { StorageStats, AircraftSummary } from "@/lib/types";

const sampleStats: StorageStats = {
  row_count: 1000,
  db_size_bytes: 128000,
  oldest_timestamp_ms: 1705315800000,
  newest_timestamp_ms: 1705316100000,
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

const baseProps = {
  onLoadTracks: vi.fn(),
  onClearTracks: vi.fn(),
  dbHistoryCount: 0,
};

beforeEach(() => {
  clearMockResponses();
  vi.restoreAllMocks();
});

describe("DBHistoryContent", () => {
  it("renders stats strip with row_count and db_size after loading", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-row-count")).toBeInTheDocument();
    });
    expect(screen.getByText("1,000")).toBeInTheDocument();
  });

  it("shows 'History unavailable' when storage returns error string", async () => {
    mockInvokeResponse("get_storage_stats", "Storage not available");
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-unavailable")).toBeInTheDocument();
    });
    expect(screen.getByText("History unavailable")).toBeInTheDocument();
  });

  it("browse button triggers getAircraftSummary", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockInvokeResponse("get_aircraft_summary", [sampleSummary]);
    mockInvokeResponse("get_time_distribution", []);

    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-browse-btn")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("dbhist-browse-btn"));

    await waitFor(() => {
      expect(screen.getByText("TEST123")).toBeInTheDocument();
    });
  });

  it("load button calls getTrajectory then onLoadTracks", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockInvokeResponse("get_aircraft_summary", [sampleSummary]);
    mockInvokeResponse("get_time_distribution", []);
    mockInvokeResponse("get_trajectory", [
      {
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
      },
    ]);

    const onLoad = vi.fn();
    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} onLoadTracks={onLoad} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-browse-btn")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-browse-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-load-A1B2C3")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-load-A1B2C3"));

    await waitFor(() => {
      expect(onLoad).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ hex_ident: "A1B2C3" }),
        ]),
      );
    });
  });

  it("wraps track list in a foldable details/summary element", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockInvokeResponse("get_aircraft_summary", [sampleSummary, { ...sampleSummary, hex_ident: "D4E5F6", callsign: "OTHER99", position_count: 10, min_altitude: 20000, max_altitude: 25000 }]);
    mockInvokeResponse("get_time_distribution", []);

    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-browse-btn")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-browse-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-track-list")).toBeInTheDocument();
    });

    const details = screen.getByTestId("dbhist-track-list");
    expect(details.tagName).toBe("DETAILS");
    // Summary should show aircraft count
    expect(details.querySelector("summary")).toHaveTextContent("Aircraft (2)");
    // Should be open by default
    expect(details).toHaveAttribute("open");
  });

  it("clear button calls onClearTracks when dbHistoryCount > 0", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockInvokeResponse("get_aircraft_summary", [sampleSummary]);
    mockInvokeResponse("get_time_distribution", []);

    const onClear = vi.fn();
    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} onClearTracks={onClear} dbHistoryCount={2} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-browse-btn")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-browse-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-clear-btn")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-clear-btn"));
    expect(onClear).toHaveBeenCalled();
  });
});

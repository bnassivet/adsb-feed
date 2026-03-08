import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import { DBHistoryContent } from "../DBHistoryContent";
import type { StorageStats, AircraftSummary } from "@/lib/types";

const sampleStats: StorageStats = {
  row_count: 1000,
  db_size_bytes: 1128000,
  oldest_timestamp_ms: 1705315800000,
  newest_timestamp_ms: 1705316100000,
  raw_message_count: 5000,
  raw_db_size_bytes: 1000000,
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

/** Set up mocks for a successful browse (summaries + time distribution + heatmap). */
function mockBrowseResponses(summaries: AircraftSummary[] = [sampleSummary]) {
  mockInvokeResponse("get_aircraft_summary", summaries);
  mockInvokeResponse("get_time_distribution", []);
  mockInvokeResponse("get_hourly_heatmap", []);
}

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

  it("preset 24h is highlighted by default", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-presets")).toBeInTheDocument();
    });

    const btn24h = screen.getByTestId("dbhist-preset-24h");
    expect(btn24h).toHaveClass("bg-cyan-900/60");
  });

  it("clicking a preset triggers browse with summaries", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockBrowseResponses();

    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-preset-24h")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("dbhist-preset-24h"));

    await waitFor(() => {
      expect(screen.getByText("TEST123")).toBeInTheDocument();
    });
  });

  it("custom preset shows datetime inputs, non-custom hides them", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockBrowseResponses();

    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-presets")).toBeInTheDocument();
    });

    // Initially 24h is selected — no datetime inputs visible
    expect(screen.queryByTestId("dbhist-custom-inputs")).not.toBeInTheDocument();

    // Click Custom → datetime inputs should appear
    await user.click(screen.getByTestId("dbhist-preset-custom"));
    expect(screen.getByTestId("dbhist-custom-inputs")).toBeInTheDocument();

    // Click 1w → datetime inputs should disappear
    await user.click(screen.getByTestId("dbhist-preset-1w"));
    await waitFor(() => {
      expect(screen.queryByTestId("dbhist-custom-inputs")).not.toBeInTheDocument();
    });
  });

  it("custom mode shows Browse button that triggers query", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockBrowseResponses();

    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-presets")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("dbhist-preset-custom"));
    expect(screen.getByTestId("dbhist-browse-btn")).toBeInTheDocument();

    await user.click(screen.getByTestId("dbhist-browse-btn"));

    await waitFor(() => {
      expect(screen.getByText("TEST123")).toBeInTheDocument();
    });
  });

  it("load button calls getTrajectory then onLoadTracks", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockBrowseResponses();
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
      expect(screen.getByTestId("dbhist-preset-24h")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-preset-24h"));

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
    mockBrowseResponses([
      sampleSummary,
      { ...sampleSummary, hex_ident: "D4E5F6", callsign: "OTHER99", position_count: 10, min_altitude: 20000, max_altitude: 25000 },
    ]);

    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-preset-24h")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-preset-24h"));

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-track-list")).toBeInTheDocument();
    });

    const details = screen.getByTestId("dbhist-track-list");
    expect(details.tagName).toBe("DETAILS");
    expect(details.querySelector("summary")).toHaveTextContent("Aircraft (2)");
    expect(details).toHaveAttribute("open");
  });

  it("clear button calls onClearTracks when dbHistoryCount > 0", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockBrowseResponses();

    const onClear = vi.fn();
    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} onClearTracks={onClear} dbHistoryCount={2} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-preset-24h")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-preset-24h"));

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-clear-btn")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-clear-btn"));
    expect(onClear).toHaveBeenCalled();
  });

  it("calls onBrowse callback with time range when preset is clicked", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockBrowseResponses();

    const onBrowse = vi.fn();
    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} onBrowse={onBrowse} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-preset-48h")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("dbhist-preset-48h"));

    await waitFor(() => {
      expect(onBrowse).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
      );
    });
    const [startMs, endMs] = onBrowse.mock.calls[0];
    // 48h preset → endMs - startMs should be ~48h
    const diffMs = endMs - startMs;
    expect(diffMs).toBe(48 * 60 * 60 * 1000);
  });

  it("renders all 7 preset buttons", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-presets")).toBeInTheDocument();
    });

    for (const preset of ["24h", "48h", "1w", "2w", "1m", "3m", "custom"]) {
      expect(screen.getByTestId(`dbhist-preset-${preset}`)).toBeInTheDocument();
    }
  });

  it("shows refresh button after browsing that re-triggers query", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockBrowseResponses();

    const onBrowse = vi.fn();
    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} onBrowse={onBrowse} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-preset-24h")).toBeInTheDocument();
    });

    // Click 24h to trigger initial browse
    await user.click(screen.getByTestId("dbhist-preset-24h"));

    await waitFor(() => {
      expect(onBrowse).toHaveBeenCalledTimes(1);
    });

    // Refresh button should now be visible
    const refreshBtn = screen.getByTestId("dbhist-refresh-btn");
    expect(refreshBtn).toBeInTheDocument();

    // Set up mocks for the refresh query
    mockBrowseResponses();

    // Click refresh — should trigger another browse
    await user.click(refreshBtn);

    await waitFor(() => {
      expect(onBrowse).toHaveBeenCalledTimes(2);
    });
  });

  it("refresh button is not visible before browsing", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-presets")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("dbhist-refresh-btn")).not.toBeInTheDocument();
  });

  it("uses granularity to compute num_buckets in time distribution query", async () => {
    // The default granularity is "1h" and with a 24h preset, that gives num_buckets = 24
    const { invoke } = await import("@tauri-apps/api/core");
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockBrowseResponses();

    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-preset-24h")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("dbhist-preset-24h"));

    await waitFor(() => {
      const calls = (invoke as ReturnType<typeof vi.fn>).mock.calls;
      const timeDist = calls.find((c: unknown[]) => c[0] === "get_time_distribution");
      expect(timeDist).toBeDefined();
      // Args are { query: { start_ms, end_ms, num_buckets } }
      // 24h range / 1h granularity = 24 buckets
      expect(timeDist![1].query.num_buckets).toBe(24);
    });
  });
});

describe("DBHistoryContent multi-selection", () => {
  const twoSummaries: AircraftSummary[] = [
    sampleSummary,
    { ...sampleSummary, hex_ident: "D4E5F6", callsign: "OTHER99", position_count: 10, min_altitude: 20000, max_altitude: 25000 },
  ];

  async function renderWithSummaries(extraProps: Partial<typeof baseProps & { onAddToAnalysis: ReturnType<typeof vi.fn>; onSwitchToAnalysis: ReturnType<typeof vi.fn> }> = {}) {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockBrowseResponses(twoSummaries);

    const user = userEvent.setup();
    const result = render(<DBHistoryContent {...baseProps} {...extraProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-preset-24h")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-preset-24h"));

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-track-list")).toBeInTheDocument();
    });

    return { user, ...result };
  }

  it("renders checkboxes per aircraft row", async () => {
    await renderWithSummaries();
    expect(screen.getByTestId("dbhist-check-A1B2C3")).toBeInTheDocument();
    expect(screen.getByTestId("dbhist-check-D4E5F6")).toBeInTheDocument();
  });

  it("Select All toggles all checkboxes", async () => {
    const { user } = await renderWithSummaries();

    const selectAll = screen.getByTestId("dbhist-select-all").querySelector("input")!;
    expect(selectAll.checked).toBe(false);

    await user.click(selectAll);

    const check1 = screen.getByTestId("dbhist-check-A1B2C3") as HTMLInputElement;
    const check2 = screen.getByTestId("dbhist-check-D4E5F6") as HTMLInputElement;
    expect(check1.checked).toBe(true);
    expect(check2.checked).toBe(true);

    // Click again to deselect all
    await user.click(selectAll);
    expect(check1.checked).toBe(false);
    expect(check2.checked).toBe(false);
  });

  it("'→ Live' button disabled when none selected", async () => {
    await renderWithSummaries();
    const btn = screen.getByTestId("dbhist-load-to-live");
    expect(btn).toBeDisabled();
  });

  it("'→ Analysis' button visible when onAddToAnalysis provided", async () => {
    await renderWithSummaries({ onAddToAnalysis: vi.fn() });
    expect(screen.getByTestId("dbhist-load-to-analysis")).toBeInTheDocument();
  });

  it("'→ Analysis' button hidden when onAddToAnalysis not provided", async () => {
    await renderWithSummaries();
    expect(screen.queryByTestId("dbhist-load-to-analysis")).not.toBeInTheDocument();
  });

  it("'→ Analysis' calls onAddToAnalysis with fetched tracks", async () => {
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

    const onAdd = vi.fn();
    const onSwitch = vi.fn();
    const { user } = await renderWithSummaries({ onAddToAnalysis: onAdd, onSwitchToAnalysis: onSwitch });

    // Select first aircraft
    await user.click(screen.getByTestId("dbhist-check-A1B2C3"));

    // Click "→ Analysis"
    await user.click(screen.getByTestId("dbhist-load-to-analysis"));

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ hex_ident: "A1B2C3" }),
        ]),
      );
    });
    expect(onSwitch).toHaveBeenCalled();
  });
});

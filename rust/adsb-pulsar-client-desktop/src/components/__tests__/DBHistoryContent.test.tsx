import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import { DBHistoryContent } from "../DBHistoryContent";
import type { StorageStats, AircraftSummary, FlightSummary } from "@/lib/types";
import { tableToIPC, makeTable, vectorFromArray, Float64, Int32, Utf8, Bool, Int64 } from "apache-arrow";

/** Build Arrow IPC bytes matching get_trajectories_batch_arrow output schema. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMockArrowIPC(rows: {
  hex_ident: string; callsign: string | null; latitude: number; longitude: number;
  altitude: number | null; ground_speed: number | null; track: number | null;
  vertical_rate: number | null; squawk: string | null; is_on_ground: boolean | null;
  timestamp_ms: bigint; flight_id: string;
}[]): number[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = makeTable({
    hex_ident: vectorFromArray(rows.map(r => r.hex_ident), new Utf8()),
    callsign: vectorFromArray(rows.map(r => r.callsign), new Utf8()),
    latitude: vectorFromArray(rows.map(r => r.latitude), new Float64()),
    longitude: vectorFromArray(rows.map(r => r.longitude), new Float64()),
    altitude: vectorFromArray(rows.map(r => r.altitude), new Float64()),
    ground_speed: vectorFromArray(rows.map(r => r.ground_speed), new Float64()),
    track: vectorFromArray(rows.map(r => r.track), new Float64()),
    vertical_rate: vectorFromArray(rows.map(r => r.vertical_rate), new Float64()),
    squawk: vectorFromArray(rows.map(r => r.squawk), new Utf8()),
    is_on_ground: vectorFromArray(rows.map(r => r.is_on_ground), new Bool()),
    timestamp_ms: vectorFromArray(rows.map(r => r.timestamp_ms), new Int64()),
    flight_id: vectorFromArray(rows.map(r => r.flight_id), new Utf8()),
  } as any);
  return Array.from(new Uint8Array(tableToIPC(table, "stream")));
}

/** Build Arrow IPC bytes matching get_flight_summary_arrow output schema. */
function buildFlightSummaryIPC(flights: FlightSummary[]): number[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = makeTable({
    hex_ident: vectorFromArray(flights.map(f => f.hex_ident), new Utf8()),
    flight_num: vectorFromArray(flights.map(f => f.flight_num), new Int32()),
    flight_id: vectorFromArray(flights.map(f => f.flight_id), new Utf8()),
    callsign: vectorFromArray(flights.map(f => f.callsign), new Utf8()),
    position_count: vectorFromArray(flights.map(f => BigInt(f.position_count)), new Int64()),
    first_seen_ms: vectorFromArray(flights.map(f => BigInt(f.first_seen_ms)), new Int64()),
    last_seen_ms: vectorFromArray(flights.map(f => BigInt(f.last_seen_ms)), new Int64()),
    min_altitude: vectorFromArray(flights.map(f => f.min_altitude), new Float64()),
    max_altitude: vectorFromArray(flights.map(f => f.max_altitude), new Float64()),
  } as any);
  return Array.from(new Uint8Array(tableToIPC(table, "stream")));
}

const sampleStats: StorageStats = {
  row_count: 1000,
  db_size_bytes: 1128000,
  oldest_timestamp_ms: 1705315800000,
  newest_timestamp_ms: 1705316100000,
  raw_message_count: 5000,
  raw_db_size_bytes: 1000000,
  flight_count: 42,
  flight_size_bytes: 6720,
  status_event_count: 5,
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

const sampleFlight: FlightSummary = {
  hex_ident: "A1B2C3",
  flight_num: 0,
  flight_id: "A1B2C3_0",
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

/** Set up mocks for a successful browse (summaries + flights + time distribution + heatmap + raw count). */
function mockBrowseResponses(
  summaries: AircraftSummary[] = [sampleSummary],
  flights: FlightSummary[] = [sampleFlight],
) {
  mockInvokeResponse("get_aircraft_summary", summaries);
  mockInvokeResponse("get_flight_summary_arrow", buildFlightSummaryIPC(flights));
  mockInvokeResponse("get_time_distribution", []);
  mockInvokeResponse("get_hourly_heatmap", []);
  mockInvokeResponse("get_raw_message_count", 0);
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

  it("renders flight count and flight size in stats strip", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-flight-count")).toBeInTheDocument();
    });
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByTestId("dbhist-flight-size")).toBeInTheDocument();
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

  it("clicking a preset triggers browse with flight summaries", async () => {
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

  it("load button calls getTrajectory then onLoadTracks with track_id", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockBrowseResponses();
    mockInvokeResponse("get_trajectories_batch_arrow", buildMockArrowIPC([
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
        timestamp_ms: BigInt(1705315800000),
        flight_id: "A1B2C3_0",
      },
    ]));

    const onLoad = vi.fn();
    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} onLoadTracks={onLoad} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-preset-24h")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-preset-24h"));

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-load-A1B2C3_0")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-load-A1B2C3_0"));

    await waitFor(() => {
      expect(onLoad).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ hex_ident: "A1B2C3", track_id: "A1B2C3_0", callsign: "TEST123" }),
        ]),
      );
    });
  });

  it("wraps track list in a foldable details/summary with Flights label", async () => {
    const twoFlights: FlightSummary[] = [
      sampleFlight,
      { ...sampleFlight, hex_ident: "D4E5F6", flight_num: 0, flight_id: "D4E5F6_0", callsign: "OTHER99", position_count: 10, min_altitude: 20000, max_altitude: 25000 },
    ];
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockBrowseResponses(
      [sampleSummary, { ...sampleSummary, hex_ident: "D4E5F6", callsign: "OTHER99", position_count: 10, min_altitude: 20000, max_altitude: 25000 }],
      twoFlights,
    );

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
    expect(details.querySelector("summary")).toHaveTextContent("Flights (2)");
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
  const twoFlights: FlightSummary[] = [
    sampleFlight,
    { ...sampleFlight, hex_ident: "D4E5F6", flight_num: 0, flight_id: "D4E5F6_0", callsign: "OTHER99", position_count: 10, min_altitude: 20000, max_altitude: 25000 },
  ];
  const twoSummaries: AircraftSummary[] = [
    sampleSummary,
    { ...sampleSummary, hex_ident: "D4E5F6", callsign: "OTHER99", position_count: 10, min_altitude: 20000, max_altitude: 25000 },
  ];

  async function renderWithSummaries(extraProps: Partial<typeof baseProps & { onAddToAnalysis: ReturnType<typeof vi.fn>; onSwitchToAnalysis: ReturnType<typeof vi.fn> }> = {}) {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockBrowseResponses(twoSummaries, twoFlights);

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

  it("renders checkboxes per flight row keyed by flight_id", async () => {
    await renderWithSummaries();
    expect(screen.getByTestId("dbhist-check-A1B2C3_0")).toBeInTheDocument();
    expect(screen.getByTestId("dbhist-check-D4E5F6_0")).toBeInTheDocument();
  });

  it("Select All toggles all checkboxes", async () => {
    const { user } = await renderWithSummaries();

    const selectAll = screen.getByTestId("dbhist-select-all").querySelector("input")!;
    expect(selectAll.checked).toBe(false);

    await user.click(selectAll);

    const check1 = screen.getByTestId("dbhist-check-A1B2C3_0") as HTMLInputElement;
    const check2 = screen.getByTestId("dbhist-check-D4E5F6_0") as HTMLInputElement;
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

  it("'→ Analysis' calls onAddToAnalysis with fetched tracks including track_id", async () => {
    mockInvokeResponse("get_trajectories_batch_arrow", buildMockArrowIPC([
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
        timestamp_ms: BigInt(1705315800000),
        flight_id: "A1B2C3_0",
      },
    ]));

    const onAdd = vi.fn();
    const onSwitch = vi.fn();
    const { user } = await renderWithSummaries({ onAddToAnalysis: onAdd, onSwitchToAnalysis: onSwitch });

    // Select first flight
    await user.click(screen.getByTestId("dbhist-check-A1B2C3_0"));

    // Click "→ Analysis"
    await user.click(screen.getByTestId("dbhist-load-to-analysis"));

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ hex_ident: "A1B2C3", track_id: "A1B2C3_0", callsign: "TEST123" }),
        ]),
      );
    });
    expect(onSwitch).toHaveBeenCalled();
  });
});

describe("DBHistoryContent flight segmentation", () => {
  const twoFlightsSameHex: FlightSummary[] = [
    {
      hex_ident: "A1B2C3",
      flight_num: 1,
      flight_id: "A1B2C3_1",
      callsign: "FLT200",
      position_count: 20,
      first_seen_ms: 1705320000000,
      last_seen_ms: 1705323600000,
      min_altitude: 10000,
      max_altitude: 15000,
    },
    {
      hex_ident: "A1B2C3",
      flight_num: 0,
      flight_id: "A1B2C3_0",
      callsign: "FLT100",
      position_count: 42,
      first_seen_ms: 1705315800000,
      last_seen_ms: 1705316100000,
      min_altitude: 30000,
      max_altitude: 35000,
    },
  ];

  function mockFlightBrowse(flights: FlightSummary[] = twoFlightsSameHex) {
    mockInvokeResponse("get_aircraft_summary", [sampleSummary]);
    mockInvokeResponse("get_flight_summary_arrow", buildFlightSummaryIPC(flights));
    mockInvokeResponse("get_time_distribution", []);
    mockInvokeResponse("get_hourly_heatmap", []);
    mockInvokeResponse("get_raw_message_count", 0);
  }

  it("two flights for same hex_ident render with distinct keys", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockFlightBrowse();

    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-preset-24h")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-preset-24h"));

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-check-A1B2C3_0")).toBeInTheDocument();
      expect(screen.getByTestId("dbhist-check-A1B2C3_1")).toBeInTheDocument();
    });
    // Both render with distinct callsigns
    expect(screen.getByText("FLT100")).toBeInTheDocument();
    expect(screen.getByText("FLT200")).toBeInTheDocument();
  });

  it("selecting one flight doesn't select another of same hex", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockFlightBrowse();

    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-preset-24h")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-preset-24h"));

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-check-A1B2C3_0")).toBeInTheDocument();
    });

    // Select only flight 0
    await user.click(screen.getByTestId("dbhist-check-A1B2C3_0"));

    const check0 = screen.getByTestId("dbhist-check-A1B2C3_0") as HTMLInputElement;
    const check1 = screen.getByTestId("dbhist-check-A1B2C3_1") as HTMLInputElement;
    expect(check0.checked).toBe(true);
    expect(check1.checked).toBe(false);
  });

  it("trajectory uses flight's own time range", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockFlightBrowse();
    mockInvokeResponse("get_trajectories_batch_arrow", buildMockArrowIPC([
      {
        hex_ident: "A1B2C3",
        callsign: "FLT100",
        latitude: 45.5,
        longitude: -73.5,
        altitude: 35000,
        ground_speed: 450,
        track: 90,
        vertical_rate: 0,
        squawk: "1200",
        is_on_ground: false,
        timestamp_ms: BigInt(1705315800000),
        flight_id: "A1B2C3_0",
      },
    ]));

    const { invoke } = await import("@tauri-apps/api/core");
    const onLoad = vi.fn();
    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} onLoadTracks={onLoad} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-preset-24h")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-preset-24h"));

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-load-A1B2C3_0")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-load-A1B2C3_0"));

    await waitFor(() => {
      expect(onLoad).toHaveBeenCalled();
    });

    // Verify batch arrow was called with flight's own time range
    const calls = (invoke as ReturnType<typeof vi.fn>).mock.calls;
    const trajCall = calls.find((c: unknown[]) => c[0] === "get_trajectories_batch_arrow");
    expect(trajCall).toBeDefined();
    const query = trajCall![1].queries[0][0]; // first query tuple's TrajectoryQuery
    expect(query.start_ms).toBe(1705315800000); // flight's first_seen_ms
    expect(query.end_ms).toBe(1705316100000);   // flight's last_seen_ms
  });

  it("loaded tracks have track_id set to flight_id", async () => {
    mockInvokeResponse("get_storage_stats", sampleStats);
    mockFlightBrowse();
    mockInvokeResponse("get_trajectories_batch_arrow", buildMockArrowIPC([
      {
        hex_ident: "A1B2C3",
        callsign: "FLT100",
        latitude: 45.5,
        longitude: -73.5,
        altitude: 35000,
        ground_speed: 450,
        track: 90,
        vertical_rate: 0,
        squawk: "1200",
        is_on_ground: false,
        timestamp_ms: BigInt(1705315800000),
        flight_id: "A1B2C3_0",
      },
    ]));

    const onLoad = vi.fn();
    const user = userEvent.setup();
    render(<DBHistoryContent {...baseProps} onLoadTracks={onLoad} />);

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-preset-24h")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-preset-24h"));

    await waitFor(() => {
      expect(screen.getByTestId("dbhist-load-A1B2C3_0")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("dbhist-load-A1B2C3_0"));

    await waitFor(() => {
      expect(onLoad).toHaveBeenCalled();
      const tracks = onLoad.mock.calls[0][0];
      expect(tracks[0].track_id).toBe("A1B2C3_0");
    });
  });
});

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StorageStatsCard } from "../StorageStatsCard";
import { FeedStatusCard } from "../FeedStatusCard";
import { FeedMetricsCard } from "../FeedMetricsCard";
import { AircraftSummaryTable } from "../AircraftSummaryTable";
import { FlightSummaryTable } from "../FlightSummaryTable";
import { TrajectoryCard } from "../TrajectoryCard";
import { ActionConfirmCard } from "../ActionConfirmCard";
import { LiveFlightsCard } from "../LiveFlightsCard";
import { ChatCard } from "../ChatCard";

// ---------------------------------------------------------------------------
// ChatCard (shared wrapper)
// ---------------------------------------------------------------------------
describe("ChatCard", () => {
  it("shows loading skeleton when in_progress", () => {
    render(<ChatCard title="Test" status="in_progress">Content</ChatCard>);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByText("Content")).not.toBeInTheDocument();
  });

  it("shows children when complete", () => {
    render(<ChatCard title="Test" status="complete">Content</ChatCard>);
    expect(screen.getByText("Content")).toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("renders title and icon", () => {
    render(<ChatCard title="My Title" icon="🔧" status="complete">X</ChatCard>);
    expect(screen.getByText("My Title")).toBeInTheDocument();
    expect(screen.getByText("🔧")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// StorageStatsCard
// ---------------------------------------------------------------------------
describe("StorageStatsCard", () => {
  const stats = JSON.stringify({
    row_count: 150000,
    db_size_bytes: 52428800,
    oldest_timestamp_ms: 1712000000000,
    newest_timestamp_ms: 1712100000000,
    raw_message_count: 500000,
    raw_db_size_bytes: 104857600,
    flight_count: 42,
    flight_size_bytes: 1048576,
    status_event_count: 10,
  });

  it("shows loading when in_progress", () => {
    render(<StorageStatsCard status="in_progress" />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders stats when complete", () => {
    render(<StorageStatsCard status="complete" result={stats} />);
    expect(screen.getByText("150,000")).toBeInTheDocument();
    expect(screen.getByText("50.00 MB")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("500,000")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// FeedStatusCard
// ---------------------------------------------------------------------------
describe("FeedStatusCard", () => {
  it("shows running + connected status", () => {
    const result = JSON.stringify({
      is_running: true,
      socket_status: { status: "Connected" },
      pulsar_status: { status: "Disconnected" },
    });
    render(<FeedStatusCard status="complete" result={result} />);
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });

  it("shows stopped status", () => {
    const result = JSON.stringify({
      is_running: false,
      socket_status: { status: "Disconnected" },
      pulsar_status: { status: "Disconnected" },
    });
    render(<FeedStatusCard status="complete" result={result} />);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("shows error message", () => {
    const result = JSON.stringify({
      is_running: true,
      socket_status: { status: "Error", message: "Connection refused" },
      pulsar_status: { status: "Disconnected" },
    });
    render(<FeedStatusCard status="complete" result={result} />);
    expect(screen.getByText("Error: Connection refused")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// FeedMetricsCard
// ---------------------------------------------------------------------------
describe("FeedMetricsCard", () => {
  it("renders metrics when complete", () => {
    const result = JSON.stringify({
      messages_sent: 1000,
      messages_received: 5000,
      messages_parsed: 4500,
      errors: 3,
      bytes_received: 1048576,
      bytes_sent: 524288,
      retry_queue_size: 0,
      reconnection_attempts: 2,
      elapsed_secs: 3661,
      throughput_msg_per_sec: 12.5,
    });
    render(<FeedMetricsCard status="complete" result={result} />);
    expect(screen.getByText("5,000")).toBeInTheDocument();
    expect(screen.getByText("4,500")).toBeInTheDocument();
    expect(screen.getByText("12.5 msg/s")).toBeInTheDocument();
    expect(screen.getByText("1h 1m")).toBeInTheDocument();
  });

  it("does not crash when messages_parsed is missing (legacy backend shape)", () => {
    // Regression: the bare MetricsSnapshot from get_metrics used to omit
    // messages_parsed; if the LLM ever returns a payload missing it, the
    // card must degrade gracefully instead of throwing.
    const result = JSON.stringify({
      messages_sent: 1000,
      messages_received: 5000,
      errors: 0,
      bytes_received: 1024,
      bytes_sent: 512,
      retry_queue_size: 0,
      reconnection_attempts: 0,
      elapsed_secs: 60,
      throughput_msg_per_sec: 5.0,
      // messages_parsed intentionally omitted
    });
    expect(() =>
      render(<FeedMetricsCard status="complete" result={result} />),
    ).not.toThrow();
    expect(screen.getByText("5,000")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AircraftSummaryTable
// ---------------------------------------------------------------------------
describe("AircraftSummaryTable", () => {
  it("renders aircraft rows", () => {
    const result = JSON.stringify([
      {
        hex_ident: "A1B2C3",
        callsign: "UAL123",
        position_count: 42,
        first_seen_ms: 1712000000000,
        last_seen_ms: 1712003600000,
        min_altitude: 5000,
        max_altitude: 35000,
      },
    ]);
    render(<AircraftSummaryTable status="complete" result={result} />);
    expect(screen.getByText("A1B2C3")).toBeInTheDocument();
    expect(screen.getByText("UAL123")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("handles truncated result with note", () => {
    const result = JSON.stringify({
      total: 100,
      showing: 2,
      data: [
        { hex_ident: "AAA", callsign: null, position_count: 10, first_seen_ms: 0, last_seen_ms: 0, min_altitude: null, max_altitude: null },
        { hex_ident: "BBB", callsign: "TEST", position_count: 20, first_seen_ms: 0, last_seen_ms: 0, min_altitude: 1000, max_altitude: 2000 },
      ],
      note: "Showing first 2.",
    });
    render(<AircraftSummaryTable status="complete" result={result} />);
    expect(screen.getByText("Aircraft Summary (100)")).toBeInTheDocument();
    expect(screen.getByText("Showing first 2.")).toBeInTheDocument();
    expect(screen.getByText("AAA")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// FlightSummaryTable
// ---------------------------------------------------------------------------
describe("FlightSummaryTable", () => {
  it("renders flight rows", () => {
    const result = JSON.stringify([
      {
        hex_ident: "D4E5F6",
        flight_num: 0,
        flight_id: "D4E5F6_0",
        callsign: "DAL456",
        position_count: 100,
        first_seen_ms: 1712000000000,
        last_seen_ms: 1712003600000,
        min_altitude: 10000,
        max_altitude: 38000,
      },
    ]);
    render(<FlightSummaryTable status="complete" result={result} />);
    expect(screen.getByText("D4E5F6")).toBeInTheDocument();
    expect(screen.getByText("DAL456")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("1h 0m")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// TrajectoryCard
// ---------------------------------------------------------------------------
describe("TrajectoryCard", () => {
  it("renders trajectory summary", () => {
    const positions = [
      { hex_ident: "ABCDEF", callsign: null, latitude: 45.5, longitude: -73.5, altitude: 5000, ground_speed: 250, track: 90, vertical_rate: 0, squawk: null, is_on_ground: false, timestamp_ms: 1712000000000 },
      { hex_ident: "ABCDEF", callsign: null, latitude: 45.6, longitude: -73.4, altitude: 10000, ground_speed: 300, track: 90, vertical_rate: 500, squawk: null, is_on_ground: false, timestamp_ms: 1712001000000 },
    ];
    render(<TrajectoryCard status="complete" result={JSON.stringify(positions)} />);
    expect(screen.getByText("Trajectory — ABCDEF")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ActionConfirmCard
// ---------------------------------------------------------------------------
describe("ActionConfirmCard", () => {
  it("renders start action with result", () => {
    render(<ActionConfirmCard action="start" status="complete" result="Feed started successfully." />);
    expect(screen.getByText("Start Feed")).toBeInTheDocument();
    expect(screen.getByText("Feed started successfully.")).toBeInTheDocument();
  });

  it("renders stop action loading", () => {
    render(<ActionConfirmCard action="stop" status="in_progress" />);
    expect(screen.getByText("Stop Feed")).toBeInTheDocument();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// LiveFlightsCard
// ---------------------------------------------------------------------------
describe("LiveFlightsCard", () => {
  it("shows loading when in_progress", () => {
    render(<LiveFlightsCard status="in_progress" />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders flight rows when complete", () => {
    const result = JSON.stringify({
      total: 2,
      showing: 2,
      flights: [
        { hex_ident: "A1B2C3", callsign: "UAL123", altitude: 35000, ground_speed: 450, track: 90, latitude: 48.8, longitude: 2.3, squawk: "1200", is_on_ground: false },
        { hex_ident: "D4E5F6", callsign: null, altitude: 28000, ground_speed: 380, track: 180, latitude: 51.5, longitude: -0.1, squawk: "7700", is_on_ground: false },
      ],
    });
    render(<LiveFlightsCard status="complete" result={result} />);
    expect(screen.getByText("Live Flights (2/2)")).toBeInTheDocument();
    expect(screen.getByText("A1B2C3")).toBeInTheDocument();
    expect(screen.getByText("UAL123")).toBeInTheDocument();
    expect(screen.getByText("D4E5F6")).toBeInTheDocument();
    expect(screen.getByText("35,000 ft")).toBeInTheDocument();
    expect(screen.getByText("450 kts")).toBeInTheDocument();
    expect(screen.getByText("7700")).toBeInTheDocument();
  });

  it("shows truncation note when showing < total", () => {
    const result = JSON.stringify({
      total: 50,
      showing: 2,
      flights: [
        { hex_ident: "AAA", callsign: "TEST1", altitude: 10000, ground_speed: 200, track: 0, latitude: 40, longitude: -74, squawk: null, is_on_ground: false },
        { hex_ident: "BBB", callsign: "TEST2", altitude: 20000, ground_speed: 300, track: 90, latitude: 41, longitude: -75, squawk: null, is_on_ground: false },
      ],
    });
    render(<LiveFlightsCard status="complete" result={result} />);
    expect(screen.getByText("Live Flights (2/50)")).toBeInTheDocument();
    expect(screen.getByText(/Showing 2 of 50 flights/)).toBeInTheDocument();
  });

  it("shows no-match message when flights is empty", () => {
    const result = JSON.stringify({ total: 0, showing: 0, flights: [] });
    render(<LiveFlightsCard status="complete" result={result} />);
    expect(screen.getByText("No flights match the search criteria.")).toBeInTheDocument();
  });

  it("renders ground status indicators", () => {
    const result = JSON.stringify({
      total: 1,
      showing: 1,
      flights: [
        { hex_ident: "GND1", callsign: "RYR", altitude: 0, ground_speed: 15, track: 350, latitude: 40.6, longitude: -73.8, squawk: null, is_on_ground: true },
      ],
    });
    render(<LiveFlightsCard status="complete" result={result} />);
    expect(screen.getByText("🔵")).toBeInTheDocument();
  });

  it("renders heading with arrow", () => {
    const result = JSON.stringify({
      total: 1,
      showing: 1,
      flights: [
        { hex_ident: "HDG1", callsign: null, altitude: 10000, ground_speed: 200, track: 90, latitude: 45, longitude: 2, squawk: null, is_on_ground: false },
      ],
    });
    render(<LiveFlightsCard status="complete" result={result} />);
    expect(screen.getByText("→ 90°")).toBeInTheDocument();
  });
});

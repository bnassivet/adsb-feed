import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DBHistoryAnalytics } from "../DBHistoryAnalytics";
import type { AircraftSummary, HourlyHeatmapCell } from "@/lib/types";

function makeSummary(overrides: Partial<AircraftSummary> = {}): AircraftSummary {
  return {
    hex_ident: "A1B2C3",
    callsign: "TEST",
    position_count: 10,
    first_seen_ms: 1705315800000,
    last_seen_ms: 1705316100000,
    min_altitude: 30000,
    max_altitude: 35000,
    ...overrides,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const JAN15 = Date.UTC(2024, 0, 15);

function makeCell(
  day_ms: number,
  hour: number,
  aircraft_count: number,
  message_count: number,
  raw_message_count: number = 0,
): HourlyHeatmapCell {
  return { day_ms, hour, aircraft_count, message_count, raw_message_count };
}

describe("DBHistoryAnalytics — Summary stats", () => {
  const defaultProps = {
    summaries: [makeSummary({ position_count: 42 })],
    timeBuckets: [],
    tzName: "UTC",
  };

  it("displays raw messages count when provided", () => {
    render(<DBHistoryAnalytics {...defaultProps} rawMessageCount={1234} />);
    const details = screen.getByTestId("dbhist-analytics");
    details.setAttribute("open", "");
    expect(screen.getByText("Raw Msgs")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
  });

  it("displays 0 raw messages when not provided", () => {
    render(<DBHistoryAnalytics {...defaultProps} />);
    const details = screen.getByTestId("dbhist-analytics");
    details.setAttribute("open", "");
    expect(screen.getByText("Raw Msgs")).toBeInTheDocument();
    // The "0" text appears in the Raw Msgs card; use getAllByText since other elements may also show "0"
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(1);
  });
});

describe("DBHistoryAnalytics — Activity Heatmap", () => {
  const defaultProps = {
    summaries: [makeSummary()],
    timeBuckets: [],
    tzName: "UTC",
  };

  it("renders heatmap section when cells are provided", () => {
    const cells = [makeCell(JAN15, 10, 5, 100)];
    render(
      <DBHistoryAnalytics
        {...defaultProps}
        heatmapCells={cells}
        startMs={JAN15}
        endMs={JAN15 + DAY_MS}
      />,
    );
    // Open the details
    const details = screen.getByTestId("dbhist-analytics");
    details.setAttribute("open", "");
    expect(screen.getByTestId("heatmap-section")).toBeInTheDocument();
    expect(screen.getByText("Activity Heatmap")).toBeInTheDocument();
  });

  it("does not render heatmap when no cells", () => {
    render(<DBHistoryAnalytics {...defaultProps} heatmapCells={[]} startMs={JAN15} endMs={JAN15 + DAY_MS} />);
    const details = screen.getByTestId("dbhist-analytics");
    details.setAttribute("open", "");
    expect(screen.queryByTestId("heatmap-section")).not.toBeInTheDocument();
  });

  it("does not render heatmap when cells prop is undefined", () => {
    render(<DBHistoryAnalytics {...defaultProps} />);
    const details = screen.getByTestId("dbhist-analytics");
    details.setAttribute("open", "");
    expect(screen.queryByTestId("heatmap-section")).not.toBeInTheDocument();
  });

  it("shows Aircraft/Messages/Raw Msgs toggle", () => {
    const cells = [makeCell(JAN15, 10, 5, 100, 300)];
    render(
      <DBHistoryAnalytics
        {...defaultProps}
        heatmapCells={cells}
        startMs={JAN15}
        endMs={JAN15 + DAY_MS}
      />,
    );
    const details = screen.getByTestId("dbhist-analytics");
    details.setAttribute("open", "");
    expect(screen.getByTestId("heatmap-metric-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("heatmap-metric-aircraft")).toBeInTheDocument();
    expect(screen.getByTestId("heatmap-metric-messages")).toBeInTheDocument();
    expect(screen.getByTestId("heatmap-metric-raw_messages")).toBeInTheDocument();
  });

  it("toggles between aircraft, messages, and raw_messages metric", async () => {
    const user = userEvent.setup();
    const cells = [makeCell(JAN15, 10, 5, 100, 300)];
    render(
      <DBHistoryAnalytics
        {...defaultProps}
        heatmapCells={cells}
        startMs={JAN15}
        endMs={JAN15 + DAY_MS}
      />,
    );
    const details = screen.getByTestId("dbhist-analytics");
    details.setAttribute("open", "");

    // Aircraft button should be active initially (cyan text)
    const aircraftBtn = screen.getByTestId("heatmap-metric-aircraft");
    const messagesBtn = screen.getByTestId("heatmap-metric-messages");
    const rawBtn = screen.getByTestId("heatmap-metric-raw_messages");
    expect(aircraftBtn.className).toContain("text-cyan-300");

    // Click Messages
    await user.click(messagesBtn);
    expect(messagesBtn.className).toContain("text-cyan-300");

    // Click Raw Msgs
    await user.click(rawBtn);
    expect(rawBtn.className).toContain("text-cyan-300");
  });

  it("renders correct number of hour columns", () => {
    const cells = [makeCell(JAN15, 10, 5, 100)];
    const { container } = render(
      <DBHistoryAnalytics
        {...defaultProps}
        heatmapCells={cells}
        startMs={JAN15}
        endMs={JAN15 + DAY_MS}
      />,
    );
    const details = screen.getByTestId("dbhist-analytics");
    details.setAttribute("open", "");
    // Header row has 24 hour labels (0–23)
    const hourHeaders = container.querySelectorAll("[data-testid='heatmap-section'] .inline-grid > div");
    // First row: 1 label + 24 hours = 25, then data rows
    // Just check that "23" appears (last hour) and "0" appears (first hour)
    expect(screen.getByText("23")).toBeInTheDocument();
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(1);
    expect(hourHeaders.length).toBeGreaterThanOrEqual(25);
  });
});

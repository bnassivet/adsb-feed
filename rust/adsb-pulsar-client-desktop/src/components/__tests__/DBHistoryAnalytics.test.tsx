import { beforeEach, describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

describe("DBHistoryAnalytics — Raw message types", () => {
  const T0 = Date.UTC(2024, 0, 15, 10, 0);
  const T1 = Date.UTC(2024, 0, 15, 11, 0);
  const typeRows = [
    { bucket_ms: T0, transmission_type: 3, count: 6 },
    { bucket_ms: T0, transmission_type: 4, count: 2 },
    { bucket_ms: T1, transmission_type: 3, count: 2 },
  ];
  const rawProps = {
    summaries: [makeSummary()],
    timeBuckets: [
      { bucket_ms: T0, count: 8 },
      { bucket_ms: T1, count: 2 },
    ],
    tzName: "UTC",
    timeMetric: "raw_messages" as const,
    onTimeMetricChange: () => {},
    messageTypeBuckets: typeRows,
  };

  beforeEach(() => {
    localStorage.clear();
  });

  it("offers a 'By type' toggle on the Raw Msgs histogram, stacked by default, with a legend", () => {
    render(<DBHistoryAnalytics {...rawProps} />);
    const toggle = screen.getByTestId("dbhist-stack-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const legend = screen.getByTestId("dbhist-type-legend");
    // Only the types present in the range are listed
    expect(legend).toHaveTextContent("MSG3 Position");
    expect(legend).toHaveTextContent("MSG4 Velocity");
    expect(legend).not.toHaveTextContent("MSG1 ID");
  });

  it("toggling off hides the legend and remembers the choice", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DBHistoryAnalytics {...rawProps} />);
    await user.click(screen.getByTestId("dbhist-stack-toggle"));
    expect(screen.getByTestId("dbhist-stack-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("dbhist-type-legend")).not.toBeInTheDocument();
    unmount();
    render(<DBHistoryAnalytics {...rawProps} />);
    expect(screen.getByTestId("dbhist-stack-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("each legend type is a single-click toggle, on by default", async () => {
    const user = userEvent.setup();
    render(<DBHistoryAnalytics {...rawProps} />);
    const t3 = screen.getByTestId("dbhist-type-legend-t3");
    const t4 = screen.getByTestId("dbhist-type-legend-t4");
    expect(t3).toHaveAttribute("aria-pressed", "true");
    expect(t4).toHaveAttribute("aria-pressed", "true");

    await user.click(t4);
    expect(t4).toHaveAttribute("aria-pressed", "false");
    expect(t3).toHaveAttribute("aria-pressed", "true");

    await user.click(t4);
    expect(t4).toHaveAttribute("aria-pressed", "true");
  });

  describe("double-click", () => {
    const threeTypes = {
      ...rawProps,
      messageTypeBuckets: [...typeRows, { bucket_ms: T1, transmission_type: 1, count: 1 }],
    };
    const pressed = (key: string) => screen.getByTestId(`dbhist-type-legend-${key}`).getAttribute("aria-pressed");

    it("with every type on, switches off all the others", async () => {
      const user = userEvent.setup();
      render(<DBHistoryAnalytics {...threeTypes} />);
      await user.dblClick(screen.getByTestId("dbhist-type-legend-t3"));
      expect([pressed("t1"), pressed("t3"), pressed("t4")]).toEqual(["false", "true", "false"]);
    });

    it("with any type off, switches every type back on", async () => {
      const user = userEvent.setup();
      render(<DBHistoryAnalytics {...threeTypes} />);
      await user.click(screen.getByTestId("dbhist-type-legend-t4"));
      await user.dblClick(screen.getByTestId("dbhist-type-legend-t1"));
      expect([pressed("t1"), pressed("t3"), pressed("t4")]).toEqual(["true", "true", "true"]);
    });

    it("works from a type that is currently off", async () => {
      const user = userEvent.setup();
      render(<DBHistoryAnalytics {...threeTypes} />);
      await user.dblClick(screen.getByTestId("dbhist-type-legend-t3")); // isolate t3
      await user.dblClick(screen.getByTestId("dbhist-type-legend-t4")); // t4 is off
      expect([pressed("t1"), pressed("t3"), pressed("t4")]).toEqual(["true", "true", "true"]);
    });

    it("alternates isolate / show all", async () => {
      const user = userEvent.setup();
      render(<DBHistoryAnalytics {...threeTypes} />);
      const t3 = screen.getByTestId("dbhist-type-legend-t3");
      await user.dblClick(t3);
      await user.dblClick(t3);
      expect([pressed("t1"), pressed("t3"), pressed("t4")]).toEqual(["true", "true", "true"]);
      await user.dblClick(t3);
      expect([pressed("t1"), pressed("t3"), pressed("t4")]).toEqual(["false", "true", "false"]);
    });
  });

  it("will not switch off the last visible type", async () => {
    const user = userEvent.setup();
    render(<DBHistoryAnalytics {...rawProps} />);
    await user.click(screen.getByTestId("dbhist-type-legend-t4"));
    const t3 = screen.getByTestId("dbhist-type-legend-t3");
    await user.click(t3);
    expect(t3).toHaveAttribute("aria-pressed", "true");
  });

  it("remembers which types are switched off", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DBHistoryAnalytics {...rawProps} />);
    await user.click(screen.getByTestId("dbhist-type-legend-t4"));
    unmount();
    render(<DBHistoryAnalytics {...rawProps} />);
    expect(screen.getByTestId("dbhist-type-legend-t4")).toHaveAttribute("aria-pressed", "false");
  });

  describe("Message Types filter (shared with the stacked histogram)", () => {
    it("has its own MSG filter row", () => {
      render(<DBHistoryAnalytics {...rawProps} />);
      expect(screen.getByTestId("msgtype-filter-t3")).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("msgtype-filter-t4")).toHaveAttribute("aria-pressed", "true");
    });

    it("hiding a type removes it from the bars and rebases the shares", async () => {
      const user = userEvent.setup();
      render(<DBHistoryAnalytics {...rawProps} />);
      await user.click(screen.getByTestId("msgtype-filter-t4"));
      expect(screen.queryByTestId("msgtype-row-t4")).not.toBeInTheDocument();
      expect(within(screen.getByTestId("msgtype-row-t3")).getByText("100.0%")).toBeInTheDocument();
    });

    it("hiding a type removes its slice from the donut", async () => {
      const user = userEvent.setup();
      render(<DBHistoryAnalytics {...rawProps} />);
      await user.click(screen.getByTestId("msgtype-show-pie"));
      await user.click(screen.getByTestId("msgtype-filter-t4"));
      expect(screen.queryByTestId("msgtype-slice-t4")).not.toBeInTheDocument();
      expect(screen.getByTestId("msgtype-donut-center")).toHaveTextContent("8"); // visible total only
    });

    it("is one selection: hiding in Message Types hides in the histogram legend too", async () => {
      const user = userEvent.setup();
      render(<DBHistoryAnalytics {...rawProps} />);
      await user.click(screen.getByTestId("msgtype-filter-t4"));
      expect(screen.getByTestId("dbhist-type-legend-t4")).toHaveAttribute("aria-pressed", "false");
    });

    it("...and the other way round", async () => {
      const user = userEvent.setup();
      render(<DBHistoryAnalytics {...rawProps} />);
      await user.click(screen.getByTestId("dbhist-type-legend-t4"));
      expect(screen.getByTestId("msgtype-filter-t4")).toHaveAttribute("aria-pressed", "false");
      expect(screen.queryByTestId("msgtype-row-t4")).not.toBeInTheDocument();
    });

    it("works under any metric, where the histogram has no legend", async () => {
      const user = userEvent.setup();
      render(<DBHistoryAnalytics {...rawProps} timeMetric="aircraft" />);
      await user.click(screen.getByTestId("msgtype-filter-t4"));
      expect(screen.queryByTestId("msgtype-row-t4")).not.toBeInTheDocument();
    });

    it("double-click isolates, then shows all", async () => {
      const user = userEvent.setup();
      render(<DBHistoryAnalytics {...rawProps} />);
      await user.dblClick(screen.getByTestId("msgtype-filter-t3"));
      expect(screen.queryByTestId("msgtype-row-t4")).not.toBeInTheDocument();
      await user.dblClick(screen.getByTestId("msgtype-filter-t3"));
      expect(screen.getByTestId("msgtype-row-t4")).toBeInTheDocument();
    });

    it("hovering a Message Types row does not dim the others", async () => {
      const user = userEvent.setup();
      render(<DBHistoryAnalytics {...rawProps} />);
      await user.hover(screen.getByTestId("msgtype-row-t3"));
      expect(screen.getByTestId("msgtype-row-t4").style.opacity).not.toBe("0.25");
    });
  });

  it("does not offer the toggle for other metrics", () => {
    render(<DBHistoryAnalytics {...rawProps} timeMetric="positions" />);
    expect(screen.queryByTestId("dbhist-stack-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dbhist-type-legend")).not.toBeInTheDocument();
  });

  it("does not offer the toggle when there is no type breakdown", () => {
    render(<DBHistoryAnalytics {...rawProps} messageTypeBuckets={[]} />);
    expect(screen.queryByTestId("dbhist-stack-toggle")).not.toBeInTheDocument();
  });

  it("shows a message type distribution with counts and shares, whatever the metric", () => {
    render(<DBHistoryAnalytics {...rawProps} timeMetric="aircraft" />);
    const dist = screen.getByTestId("msgtype-distribution");
    const rows = within(dist).getAllByTestId(/^msgtype-row-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual(["msgtype-row-t3", "msgtype-row-t4"]);
    expect(within(rows[0]).getByText("MSG3 Position")).toBeInTheDocument();
    expect(within(rows[0]).getByText("8")).toBeInTheDocument();
    expect(within(rows[0]).getByText("80.0%")).toBeInTheDocument();
    expect(within(rows[1]).getByText("20.0%")).toBeInTheDocument();
  });

  it("shows bars by default and adds the pie alongside them (not exclusive)", async () => {
    const user = userEvent.setup();
    render(<DBHistoryAnalytics {...rawProps} />);
    expect(screen.getByTestId("msgtype-show-bars")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("msgtype-show-pie")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("msgtype-pie")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("msgtype-show-pie"));
    expect(screen.getByTestId("msgtype-row-t3")).toBeInTheDocument();
    const pie = screen.getByTestId("msgtype-pie");
    expect(within(pie).getByTestId("msgtype-slice-t3")).toBeInTheDocument();
    expect(within(pie).getByTestId("msgtype-slice-t4")).toBeInTheDocument();
    const key = screen.getByTestId("msgtype-pie-key");
    expect(key).toHaveTextContent("MSG3 Position");
    expect(key).toHaveTextContent("80.0%");
  });

  it("draws the pie as a donut with the total in the centre, and the hovered type on hover", async () => {
    const user = userEvent.setup();
    render(<DBHistoryAnalytics {...rawProps} />);
    await user.click(screen.getByTestId("msgtype-show-pie"));
    expect(screen.getByTestId("msgtype-pie")).toHaveAttribute("width", "120"); // 25% up from 96
    const centre = screen.getByTestId("msgtype-donut-center");
    expect(centre).toHaveTextContent("10");
    expect(centre).toHaveTextContent("msgs");

    await user.hover(screen.getByTestId("msgtype-slice-t3"));
    expect(centre).toHaveTextContent("80.0%");
    expect(centre).toHaveTextContent("MSG3");

    await user.unhover(screen.getByTestId("msgtype-pie"));
    expect(centre).toHaveTextContent("10");
  });

  it("can show the pie alone, but never neither", async () => {
    const user = userEvent.setup();
    render(<DBHistoryAnalytics {...rawProps} />);
    await user.click(screen.getByTestId("msgtype-show-pie"));
    await user.click(screen.getByTestId("msgtype-show-bars"));
    expect(screen.queryByTestId("msgtype-row-t3")).not.toBeInTheDocument();
    expect(screen.getByTestId("msgtype-pie")).toBeInTheDocument();

    await user.click(screen.getByTestId("msgtype-show-pie")); // last one on: refused
    expect(screen.getByTestId("msgtype-show-pie")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("msgtype-pie")).toBeInTheDocument();
  });

  it("remembers which displays are on", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DBHistoryAnalytics {...rawProps} />);
    await user.click(screen.getByTestId("msgtype-show-pie"));
    unmount();
    render(<DBHistoryAnalytics {...rawProps} />);
    expect(screen.getByTestId("msgtype-pie")).toBeInTheDocument();
    expect(screen.getByTestId("msgtype-row-t3")).toBeInTheDocument();
  });

  it.each(["bars", "pie"] as const)("toggles counts and percentages independently (%s alone)", async (view) => {
    const user = userEvent.setup();
    render(<DBHistoryAnalytics {...rawProps} />);
    if (view === "pie") {
      await user.click(screen.getByTestId("msgtype-show-pie"));
      await user.click(screen.getByTestId("msgtype-show-bars"));
    }
    const dist = screen.getByTestId("msgtype-distribution");
    expect(within(dist).getByText("8")).toBeInTheDocument();
    expect(within(dist).getByText("80.0%")).toBeInTheDocument();

    await user.click(screen.getByTestId("msgtype-show-count"));
    expect(screen.getByTestId("msgtype-show-count")).toHaveAttribute("aria-pressed", "false");
    expect(within(dist).queryByText("8")).not.toBeInTheDocument();
    expect(within(dist).getByText("80.0%")).toBeInTheDocument();

    await user.click(screen.getByTestId("msgtype-show-pct"));
    expect(within(dist).queryByText("80.0%")).not.toBeInTheDocument();
    // Labels survive with both values off (in the filter row and the chart)
    expect(within(dist).getAllByText("MSG3 Position").length).toBeGreaterThan(0);
  });

  it("value toggles apply to both displays when both are on", async () => {
    const user = userEvent.setup();
    render(<DBHistoryAnalytics {...rawProps} />);
    await user.click(screen.getByTestId("msgtype-show-pie"));
    const dist = screen.getByTestId("msgtype-distribution");
    expect(within(dist).getAllByText("80.0%")).toHaveLength(2);
    await user.click(screen.getByTestId("msgtype-show-pct"));
    expect(within(dist).queryAllByText("80.0%")).toHaveLength(0);
  });

  it("remembers the count / percentage choices", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DBHistoryAnalytics {...rawProps} />);
    await user.click(screen.getByTestId("msgtype-show-pct"));
    unmount();
    render(<DBHistoryAnalytics {...rawProps} />);
    expect(screen.getByTestId("msgtype-show-pct")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("msgtype-show-count")).toHaveAttribute("aria-pressed", "true");
  });

  it("hides the distribution when there are no raw messages", () => {
    render(<DBHistoryAnalytics {...rawProps} messageTypeBuckets={[]} />);
    expect(screen.queryByTestId("msgtype-distribution")).not.toBeInTheDocument();
  });
});

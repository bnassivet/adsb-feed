import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import { StatusTimeline, formatDuration } from "../StatusTimeline";
import type { StatusEvent } from "@/lib/types";

const baseTime = 1705315800000; // fixed reference

const sampleEvents: StatusEvent[] = [
  { timestamp_ms: baseTime + 300_000, event_type: "socket", status: "Connected", detail: "no message for 0s", source_id: "desktop" },
  { timestamp_ms: baseTime + 60_000, event_type: "feed", status: "Connecting", detail: null, source_id: "desktop" },
  { timestamp_ms: baseTime, event_type: "feed", status: "Started", detail: null, source_id: "desktop" },
];

describe("StatusTimeline", () => {
  beforeEach(() => {
    clearMockResponses();
  });

  it("renders empty state when no events", async () => {
    mockInvokeResponse("get_status_timeline", []);
    render(<StatusTimeline />);
    expect(await screen.findByTestId("status-timeline-empty")).toHaveTextContent("No status events");
  });

  it("renders events with correct timestamps and status", async () => {
    mockInvokeResponse("get_status_timeline", sampleEvents);
    render(<StatusTimeline />);

    const list = await screen.findByTestId("status-timeline-list");
    const badges = within(list).getAllByTestId("status-type-badge");
    const texts = within(list).getAllByTestId("status-text");

    expect(badges).toHaveLength(3);
    expect(texts[0]).toHaveTextContent("Connected");
    expect(texts[1]).toHaveTextContent("Connecting");
    expect(texts[2]).toHaveTextContent("Started");

    expect(badges[0]).toHaveTextContent("Socket");
    expect(badges[1]).toHaveTextContent("Feed");
  });

  it("shows duration between consecutive events", async () => {
    mockInvokeResponse("get_status_timeline", sampleEvents);
    render(<StatusTimeline />);

    await screen.findByTestId("status-timeline-list");
    const durations = screen.getAllByTestId("status-duration");
    // Events are DESC: [+300_000, +60_000, 0]
    // Duration from event[1] to event[0]: 300_000 - 60_000 = 240_000ms = 4m
    // Duration from event[2] to event[1]: 60_000 - 0 = 60_000ms = 1m
    expect(durations).toHaveLength(2);
    expect(durations[0]).toHaveTextContent("4m later");
    expect(durations[1]).toHaveTextContent("1m later");
  });

  it("displays event detail when present", async () => {
    mockInvokeResponse("get_status_timeline", sampleEvents);
    render(<StatusTimeline />);

    await screen.findByTestId("status-timeline-list");
    const details = screen.getAllByTestId("status-detail");
    expect(details).toHaveLength(1);
    expect(details[0]).toHaveTextContent("no message for 0s");
  });

  it("renders color-coded dots per status", async () => {
    const events: StatusEvent[] = [
      { timestamp_ms: baseTime + 200_000, event_type: "feed", status: "Error", detail: "fatal", source_id: null },
      { timestamp_ms: baseTime, event_type: "feed", status: "Started", detail: null, source_id: null },
    ];
    mockInvokeResponse("get_status_timeline", events);
    render(<StatusTimeline />);

    await screen.findByTestId("status-timeline-list");
    const dots = screen.getAllByTestId("status-dot");
    expect(dots[0].className).toContain("bg-red-500");    // Error
    expect(dots[1].className).toContain("bg-green-500");   // Started
  });

  it("type filter buttons filter by event type", async () => {
    // First render: all events
    mockInvokeResponse("get_status_timeline", sampleEvents);
    render(<StatusTimeline />);
    await screen.findByTestId("status-timeline-list");

    // Click "Feed" filter — triggers new fetch
    const feedOnlyEvents = sampleEvents.filter(e => e.event_type === "feed");
    mockInvokeResponse("get_status_timeline", feedOnlyEvents);

    const user = userEvent.setup();
    await user.click(screen.getByTestId("status-filter-feed"));

    const list = await screen.findByTestId("status-timeline-list");
    const texts = within(list).getAllByTestId("status-text");
    expect(texts).toHaveLength(2);
    expect(texts[0]).toHaveTextContent("Connecting");
    expect(texts[1]).toHaveTextContent("Started");
  });

  // --- Time range selection ---

  it("renders time range preset buttons", () => {
    mockInvokeResponse("get_status_timeline", []);
    render(<StatusTimeline />);
    expect(screen.getByTestId("status-timeline-presets")).toBeInTheDocument();
    expect(screen.getByTestId("status-preset-24h")).toBeInTheDocument();
    expect(screen.getByTestId("status-preset-1w")).toBeInTheDocument();
    expect(screen.getByTestId("status-preset-custom")).toBeInTheDocument();
  });

  it("defaults to 24h preset", () => {
    mockInvokeResponse("get_status_timeline", []);
    render(<StatusTimeline />);
    const btn = screen.getByTestId("status-preset-24h");
    expect(btn.className).toContain("bg-cyan-900");
  });

  it("clicking a preset re-fetches events", async () => {
    mockInvokeResponse("get_status_timeline", []);
    render(<StatusTimeline />);
    await screen.findByTestId("status-timeline-empty");

    // Switch to 1w — triggers new fetch
    mockInvokeResponse("get_status_timeline", sampleEvents);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("status-preset-1w"));

    const list = await screen.findByTestId("status-timeline-list");
    expect(within(list).getAllByTestId("status-text")).toHaveLength(3);
  });

  it("shows custom datetime inputs when custom preset selected", async () => {
    mockInvokeResponse("get_status_timeline", []);
    render(<StatusTimeline />);

    // Custom inputs should not be visible initially
    expect(screen.queryByTestId("status-custom-inputs")).not.toBeInTheDocument();

    const user = userEvent.setup();
    mockInvokeResponse("get_status_timeline", []);
    await user.click(screen.getByTestId("status-preset-custom"));

    expect(screen.getByTestId("status-custom-inputs")).toBeInTheDocument();
    expect(screen.getByTestId("status-custom-start")).toBeInTheDocument();
    expect(screen.getByTestId("status-custom-end")).toBeInTheDocument();
    expect(screen.getByTestId("status-custom-browse")).toBeInTheDocument();
  });

  it("custom browse button fetches events", async () => {
    mockInvokeResponse("get_status_timeline", []);
    render(<StatusTimeline />);

    const user = userEvent.setup();
    // Switch to custom
    mockInvokeResponse("get_status_timeline", []);
    await user.click(screen.getByTestId("status-preset-custom"));

    // Click browse
    mockInvokeResponse("get_status_timeline", sampleEvents);
    await user.click(screen.getByTestId("status-custom-browse"));

    const list = await screen.findByTestId("status-timeline-list");
    expect(within(list).getAllByTestId("status-text")).toHaveLength(3);
  });
});

describe("formatDuration", () => {
  it("formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  it("formats seconds", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(45000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3_660_000)).toBe("1h 1m");
    expect(formatDuration(7_200_000)).toBe("2h");
  });
});

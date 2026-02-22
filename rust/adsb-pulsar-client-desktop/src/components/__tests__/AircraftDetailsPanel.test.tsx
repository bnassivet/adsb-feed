import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AircraftDetailsPanel } from "../AircraftDetailsPanel";
import type { AircraftTrack } from "@/lib/types";

function makeTrack(overrides?: Partial<AircraftTrack>): AircraftTrack {
  return {
    hex_ident: "ABC123",
    callsign: "UAL123",
    altitude: 35000,
    ground_speed: 450,
    track: 180,
    latitude: 45.5,
    longitude: -73.6,
    vertical_rate: 2400,
    squawk: "1200",
    is_on_ground: false,
    timestamp: "",
    positions: [
      [45.5, -73.6, 34000],
      [45.6, -73.7, 35000],
    ],
    first_seen: Date.now() - 60000,
    last_seen: Date.now() - 3000,
    message_count: 42,
    ...overrides,
  };
}

// jsdom doesn't have ResizeObserver
beforeEach(() => {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
});

describe("AircraftDetailsPanel rendering", () => {
  it("renders nothing when track is null", () => {
    const { container } = render(
      <AircraftDetailsPanel
        track={null}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders fold button (<<) when open with a track", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack()}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByTitle("Fold panel")).toBeInTheDocument();
  });

  it("renders unfold strip (>>) when isOpen is false", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack()}
        isOpen={false}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByTitle("Unfold panel")).toBeInTheDocument();
  });

  it("calls onToggle when fold button is clicked", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <AircraftDetailsPanel
        track={makeTrack()}
        isOpen={true}
        width={280}
        onToggle={onToggle}
        onWidthChange={vi.fn()}
      />,
    );
    await user.click(screen.getByTitle("Fold panel"));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("calls onToggle when unfold strip button is clicked", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <AircraftDetailsPanel
        track={makeTrack()}
        isOpen={false}
        width={280}
        onToggle={onToggle}
        onWidthChange={vi.fn()}
      />,
    );
    await user.click(screen.getByTitle("Unfold panel"));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe("AircraftDetailsPanel content", () => {
  it("shows hex_ident prominently", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack()}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByText("ABC123")).toBeInTheDocument();
  });

  it("shows callsign when provided", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({ callsign: "UAL123" })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByText("UAL123")).toBeInTheDocument();
  });

  it("shows em dash for null callsign", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({ callsign: null })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    // Should show "—" for missing callsign
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
  });

  it("shows altitude value", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({ altitude: 35000 })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByText("35,000 ft")).toBeInTheDocument();
  });

  it("shows ground speed value", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({ ground_speed: 450 })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByText("450 kts")).toBeInTheDocument();
  });

  it("shows heading value", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({ track: 180 })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByText("180°")).toBeInTheDocument();
  });

  it("renders climbing arrow for positive vertical_rate above threshold", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({ vertical_rate: 2400 })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("tendency-climbing")).toBeInTheDocument();
  });

  it("renders descending arrow for negative vertical_rate below threshold", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({ vertical_rate: -1200 })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("tendency-descending")).toBeInTheDocument();
  });

  it("renders level arrow for small vertical_rate", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({ vertical_rate: 50 })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("tendency-level")).toBeInTheDocument();
  });

  it("renders level arrow for null vertical_rate", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({ vertical_rate: null })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("tendency-level")).toBeInTheDocument();
  });

  it("renders sparkline SVG polyline when altitude history available", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({
          positions: [
            [45.5, -73.6, 34000],
            [45.6, -73.7, 35000],
          ],
        })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(document.querySelector("polyline")).toBeTruthy();
  });

  it("shows message count", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({ message_count: 42 })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("shows squawk code", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({ squawk: "7700" })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByText("7700")).toBeInTheDocument();
  });

  it("shows min altitude label in sparkline y-axis", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({
          positions: [
            [45.5, -73.6, 10000],
            [45.6, -73.7, 35000],
          ],
        })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("sparkline-alt-min")).toBeInTheDocument();
    expect(screen.getByTestId("sparkline-alt-min").textContent).toContain("10,000");
  });

  it("shows max altitude label in sparkline y-axis", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({
          positions: [
            [45.5, -73.6, 10000],
            [45.6, -73.7, 35000],
          ],
        })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("sparkline-alt-max")).toBeInTheDocument();
    expect(screen.getByTestId("sparkline-alt-max").textContent).toContain("35,000");
  });

  it("shows start time label in sparkline x-axis", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack()}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("sparkline-time-start")).toBeInTheDocument();
  });

  it("shows end time label in sparkline x-axis", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack()}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("sparkline-time-end")).toBeInTheDocument();
  });

  it("shows emergency label for squawk 7700", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({ squawk: "7700" })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    );
    expect(screen.getByText("EMERGENCY")).toBeInTheDocument();
  });

  it("shows IMPORTED badge when isImported is true", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({ positions: [] })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
        isImported={true}
      />,
    );
    expect(screen.getByText("IMPORTED")).toBeInTheDocument();
  });

  it("does not show IMPORTED badge when isImported is false", () => {
    render(
      <AircraftDetailsPanel
        track={makeTrack({ positions: [] })}
        isOpen={true}
        width={280}
        onToggle={vi.fn()}
        onWidthChange={vi.fn()}
        isImported={false}
      />,
    );
    expect(screen.queryByText("IMPORTED")).not.toBeInTheDocument();
  });
});

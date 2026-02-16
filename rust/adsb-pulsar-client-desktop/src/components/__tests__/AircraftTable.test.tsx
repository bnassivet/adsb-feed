import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AircraftTable } from "../AircraftTable";
import type { AircraftTrack } from "@/lib/types";

// jsdom doesn't implement scrollIntoView
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function makeTrack(hex: string, overrides?: Partial<AircraftTrack>): AircraftTrack {
  return {
    hex_ident: hex,
    callsign: hex.toUpperCase(),
    altitude: 35000,
    ground_speed: 450,
    track: 180,
    latitude: 45.5,
    longitude: -73.6,
    vertical_rate: 0,
    squawk: "1200",
    is_on_ground: false,
    timestamp: "",
    positions: [],
    last_seen: Date.now(),
    message_count: 0,
    ...overrides,
  };
}

describe("AircraftTable selection", () => {
  it("calls onSelectTrack with hex_ident on row click", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(
      <AircraftTable
        tracks={[makeTrack("ABC123")]}
        selectedHexIdent={null}
        onSelectTrack={onSelect}
      />,
    );

    const row = screen.getByTestId("row-ABC123");
    await user.click(row);
    expect(onSelect).toHaveBeenCalledWith("ABC123");
  });

  it("highlights selected row with bg-blue-900/40", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("ABC123"), makeTrack("DEF456")]}
        selectedHexIdent="ABC123"
      />,
    );

    const selectedRow = screen.getByTestId("row-ABC123");
    const otherRow = screen.getByTestId("row-DEF456");
    expect(selectedRow.className).toContain("bg-blue-900/40");
    expect(otherRow.className).not.toContain("bg-blue-900/40");
  });

  it("highlights selected history row", () => {
    render(
      <AircraftTable
        tracks={[]}
        historyTracks={[makeTrack("HIST01")]}
        selectedHexIdent="HIST01"
      />,
    );

    const row = screen.getByTestId("row-hist-HIST01");
    expect(row.className).toContain("bg-blue-900/40");
  });

  it("calls onSelectTrack for history row clicks", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(
      <AircraftTable
        tracks={[]}
        historyTracks={[makeTrack("HIST01")]}
        selectedHexIdent={null}
        onSelectTrack={onSelect}
      />,
    );

    const row = screen.getByTestId("row-hist-HIST01");
    await user.click(row);
    expect(onSelect).toHaveBeenCalledWith("HIST01");
  });

  it("adds cursor-pointer to rows when onSelectTrack is provided", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("ABC123")]}
        selectedHexIdent={null}
        onSelectTrack={() => {}}
      />,
    );

    const row = screen.getByTestId("row-ABC123");
    expect(row.className).toContain("cursor-pointer");
  });

  it("auto-scrolls selected row into view", () => {
    const { rerender } = render(
      <AircraftTable
        tracks={[makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC")]}
        selectedHexIdent={null}
      />,
    );

    // Clear any prior calls, then select BBB
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    rerender(
      <AircraftTable
        tracks={[makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC")]}
        selectedHexIdent="BBB"
      />,
    );

    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "smooth",
    });
  });
});

describe("AircraftTable columns", () => {
  it("renders RxTS column header", () => {
    render(<AircraftTable tracks={[makeTrack("ABC123")]} />);
    expect(screen.getByText("RxTS")).toBeInTheDocument();
  });

  it("renders Msg# column header", () => {
    render(<AircraftTable tracks={[makeTrack("ABC123")]} />);
    expect(screen.getByText("Msg#")).toBeInTheDocument();
  });

  it("displays relative time in RxTS column", () => {
    const twoMinAgo = Date.now() - 120_000;
    render(<AircraftTable tracks={[makeTrack("ABC123", { last_seen: twoMinAgo })]} />);
    expect(screen.getByText("2m ago")).toBeInTheDocument();
  });

  it("displays message count in Msg# column", () => {
    render(<AircraftTable tracks={[makeTrack("ABC123", { message_count: 42 })]} />);
    expect(screen.getByText("42")).toBeInTheDocument();
  });
});

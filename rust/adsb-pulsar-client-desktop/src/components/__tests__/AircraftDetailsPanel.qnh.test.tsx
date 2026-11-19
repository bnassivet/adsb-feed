import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AircraftDetailsPanel } from "../AircraftDetailsPanel";
import type { AircraftTrack } from "@/lib/types";
import type { QnhSource } from "@/lib/qnh";

function track(altitude: number | null): AircraftTrack {
  return {
    hex_ident: "C0FFEE", callsign: "JZA123", altitude, ground_speed: 180, track: 60,
    latitude: 45.5, longitude: -73.6, vertical_rate: 0, squawk: "1200", is_on_ground: false, timestamp: "",
    positions: [[45.5, -73.6, altitude]], first_seen: Date.now() - 60000, last_seen: Date.now() - 3000, message_count: 7,
  };
}

const CYUL: QnhSource = { qnhHpa: 1027.2, stationId: "CYUL", distanceNm: 4.2 };

function renderPanel(altitude: number | null, qnh: QnhSource | null | undefined, transitionAltitudeFt?: number) {
  render(
    <AircraftDetailsPanel
      track={track(altitude)} isOpen width={280} onToggle={vi.fn()} onWidthChange={vi.fn()}
      qnh={qnh} transitionAltitudeFt={transitionAltitudeFt}
    />,
  );
}

beforeEach(() => {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));
});

describe("AircraftDetailsPanel altitude MSL", () => {
  it("shows the QNH-corrected altitude and its source below the transition altitude", () => {
    renderPanel(3000, CYUL);
    const row = screen.getByTestId("altitude-msl");
    expect(row).toHaveTextContent("≈ 3,370 ft");
    expect(row).toHaveTextContent("QNH 1027 CYUL");
  });

  it("is absent above the transition altitude, without QNH, or without altitude", () => {
    renderPanel(35000, CYUL);
    expect(screen.queryByTestId("altitude-msl")).toBeNull();
  });

  it("follows the configured transition altitude", () => {
    renderPanel(7000, CYUL);
    expect(screen.queryByTestId("altitude-msl")).toBeNull();
    renderPanel(7000, CYUL, 18000);
    expect(screen.getByTestId("altitude-msl")).toBeInTheDocument();
  });

  it("is absent without a QNH", () => {
    renderPanel(3000, null);
    expect(screen.queryByTestId("altitude-msl")).toBeNull();
  });

  it("labels the reported altitude as pressure altitude when a correction is shown", () => {
    renderPanel(3000, CYUL);
    expect(screen.getByText(/3,000 ft/)).toBeInTheDocument();
    expect(screen.getByText("STD")).toBeInTheDocument();
  });
});

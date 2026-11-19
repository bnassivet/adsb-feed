import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AircraftDetailsPanel } from "../AircraftDetailsPanel";
import type { AircraftTrack } from "@/lib/types";
import type { QnhSource } from "@/lib/qnh";

function track(altitude: number | null, onGround = false): AircraftTrack {
  return {
    hex_ident: "C0FFEE", callsign: "JZA123", altitude, ground_speed: 180, track: 60,
    latitude: 45.5, longitude: 6.8, vertical_rate: 0, squawk: "1200", is_on_ground: onGround, timestamp: "",
    positions: [[45.5, 6.8, altitude]], first_seen: Date.now() - 60000, last_seen: Date.now() - 3000, message_count: 7,
  };
}
const QNH: QnhSource = { qnhHpa: 1027.2, stationId: "LFLL", distanceNm: 40 };

function renderPanel(t: AircraftTrack, groundElevationM: number | null | undefined, qnh: QnhSource | null = null) {
  render(
    <AircraftDetailsPanel track={t} isOpen width={280} onToggle={vi.fn()} onWidthChange={vi.fn()} qnh={qnh} groundElevationM={groundElevationM} />,
  );
}

beforeEach(() => {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));
});

describe("AircraftDetailsPanel height above ground", () => {
  it("uses the QNH altitude when there is one, and shows the ground", () => {
    renderPanel(track(12000), 1500, QNH);
    const row = screen.getByTestId("height-agl");
    // QNH 1027.2 adds ~390 ft at this height; ground 1500 m = 4,921 ft.
    expect(row.textContent).toMatch(/≈ 7,[45]\d\d ft/);
    expect(row).toHaveTextContent("ground 1,500 m");
    expect(row).not.toHaveTextContent("std");
  });

  it("falls back to pressure altitude, marked std, without QNH", () => {
    renderPanel(track(5000), 100);
    const row = screen.getByTestId("height-agl");
    expect(row).toHaveTextContent("≈ 4,672 ft");
    expect(row).toHaveTextContent("std");
  });

  it("is absent on the ground, without altitude or without the ground height", () => {
    renderPanel(track(5000, true), 100);
    expect(screen.queryByTestId("height-agl")).toBeNull();
  });

  it("is absent without the ground height or the altitude", () => {
    renderPanel(track(5000), null);
    expect(screen.queryByTestId("height-agl")).toBeNull();
  });

  it("is absent without the altitude", () => {
    renderPanel(track(null), 100);
    expect(screen.queryByTestId("height-agl")).toBeNull();
  });
});

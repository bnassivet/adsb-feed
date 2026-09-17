import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AircraftDetailsPanel } from "../AircraftDetailsPanel";
import type { AircraftTrack } from "@/lib/types";
import type { AircraftWind } from "@/lib/aircraft-wind";

function makeTrack(): AircraftTrack {
  return {
    hex_ident: "3C6444",
    callsign: "DLH4AB",
    altitude: 34000,
    ground_speed: 480,
    track: 250,
    latitude: 46.5,
    longitude: -2.5,
    vertical_rate: 0,
    squawk: "1000",
    is_on_ground: false,
    timestamp: "",
    positions: [
      [46.4, -2.4, 34000],
      [46.5, -2.5, 34000],
    ],
    first_seen: Date.now() - 60000,
    last_seen: Date.now() - 3000,
    message_count: 42,
  };
}

function renderPanel(wind: AircraftWind | null | undefined) {
  render(
    <AircraftDetailsPanel
      track={makeTrack()}
      isOpen={true}
      width={280}
      onToggle={vi.fn()}
      onWidthChange={vi.fn()}
      wind={wind}
    />,
  );
}

// jsdom doesn't have ResizeObserver
beforeEach(() => {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
});

describe("AircraftDetailsPanel wind", () => {
  it("shows the wind at the aircraft", () => {
    renderPanel({ dirDeg: 250.4, speedKt: 98.6, headwindKt: 85.2, crosswindKt: -49.3 });

    expect(screen.getByText("Wind")).toBeInTheDocument();
    expect(screen.getByText("250° / 99 kt")).toBeInTheDocument();
    expect(screen.getByText("85 kt headwind")).toBeInTheDocument();
    expect(screen.getByText("49 kt from the left")).toBeInTheDocument();
  });

  it("calls a negative headwind a tailwind, and a positive crosswind right", () => {
    renderPanel({ dirDeg: 70, speedKt: 45, headwindKt: -40, crosswindKt: 20.4 });

    expect(screen.getByText("40 kt tailwind")).toBeInTheDocument();
    expect(screen.getByText("20 kt from the right")).toBeInTheDocument();
  });

  it("writes directions with three digits and north as 360", () => {
    renderPanel({ dirDeg: 70, speedKt: 20, headwindKt: 5, crosswindKt: 0 });
    expect(screen.getByText("070° / 20 kt")).toBeInTheDocument();
  });

  it("writes a wind from just west of north as 360, not 000", () => {
    renderPanel({ dirDeg: 359.7, speedKt: 20, headwindKt: 5, crosswindKt: 0 });
    expect(screen.getByText("360° / 20 kt")).toBeInTheDocument();
  });

  it("says there is no crosswind when it rounds to zero", () => {
    renderPanel({ dirDeg: 250, speedKt: 30, headwindKt: 30, crosswindKt: 0.3 });
    expect(screen.getByText("no crosswind")).toBeInTheDocument();
  });

  it("shows no wind row without wind data", () => {
    renderPanel(null);
    expect(screen.queryByText("Wind")).not.toBeInTheDocument();
  });

  it("shows no wind row when the prop is omitted", () => {
    renderPanel(undefined);
    expect(screen.queryByText("Wind")).not.toBeInTheDocument();
  });
});

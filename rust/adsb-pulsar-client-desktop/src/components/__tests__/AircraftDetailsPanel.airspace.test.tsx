import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AircraftDetailsPanel } from "../AircraftDetailsPanel";
import type { AircraftTrack } from "@/lib/types";
import type { QnhSource } from "@/lib/qnh";
import { normalizeAirspace, type Airspace } from "@/lib/airspace";

function track(altitude: number | null): AircraftTrack {
  return {
    hex_ident: "39C4A1", callsign: "AFR12AB", altitude, ground_speed: 220, track: 90,
    latitude: 47.1, longitude: -1.6, vertical_rate: 0, squawk: "1000", is_on_ground: false, timestamp: "",
    positions: [[47.1, -1.6, altitude]], first_seen: Date.now() - 60000, last_seen: Date.now() - 3000, message_count: 9,
  };
}

const ring = [[-2, 46.8], [-1.2, 46.8], [-1.2, 47.4], [-2, 47.4], [-2, 46.8]];
function airspace(id: string, type: number, icaoClass: number, lower: object, upper: object): Airspace {
  return normalizeAirspace({ _id: id, name: id, type, icaoClass, geometry: { type: "Polygon", coordinates: [ring] }, lowerLimit: lower, upperLimit: upper }, "FR")!;
}
const CTR = airspace("CTR TEST", 4, 3, { value: 0, unit: 1, referenceDatum: 0 }, { value: 1500, unit: 1, referenceDatum: 1 });
const TMA = airspace("TMA TEST", 7, 3, { value: 1500, unit: 1, referenceDatum: 1 }, { value: 65, unit: 6, referenceDatum: 2 });
const QNH: QnhSource = { qnhHpa: 1027.2, stationId: "LFXX", distanceNm: 5 };

function renderPanel(altitude: number | null, airspaces: Airspace[] | undefined, qnh: QnhSource | null = QNH) {
  render(
    <AircraftDetailsPanel track={track(altitude)} isOpen width={280} onToggle={vi.fn()} onWidthChange={vi.fn()} qnh={qnh} airspaces={airspaces} />,
  );
}

beforeEach(() => {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));
});

describe("AircraftDetailsPanel airspaces", () => {
  it("lists the airspaces above the aircraft with its position in each", () => {
    renderPanel(3000, [CTR, TMA]);
    const list = screen.getByRole("list", { name: /airspaces/i });
    const [ctr, tma] = within(list).getAllByRole("listitem");
    expect(ctr).toHaveTextContent("CTR TEST");
    expect(ctr).toHaveTextContent("GND – 1500 ft");
    expect(ctr).toHaveTextContent("above");
    expect(tma).toHaveTextContent("TMA TEST");
    expect(tma).toHaveTextContent("inside");
  });

  it("uses the QNH altitude: 1300 ft STD is inside a TMA based at 1500 ft MSL when QNH is high", () => {
    renderPanel(1300, [TMA]);
    expect(screen.getByRole("listitem")).toHaveTextContent("inside");
  });

  it("marks a verdict that needed QNH but had none as approximate", () => {
    renderPanel(3000, [TMA], null);
    const item = screen.getByRole("listitem");
    expect(item).toHaveTextContent("inside");
    expect(within(item).getByTitle(/without QNH/i)).toBeInTheDocument();
  });

  it("is absent when no airspace is above the aircraft", () => {
    renderPanel(3000, []);
    expect(screen.queryByRole("list", { name: /airspaces/i })).toBeNull();
    renderPanel(3000, undefined);
    expect(screen.queryByRole("list", { name: /airspaces/i })).toBeNull();
  });
});

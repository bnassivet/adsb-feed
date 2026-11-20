import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AircraftDetailsPanel } from "../AircraftDetailsPanel";
import type { AircraftTrack, FlightInfo } from "@/lib/types";
import type { UseFlightInfo } from "@/hooks/useFlightInfo";

const TRACK: AircraftTrack = {
  hex_ident: "3C6444", callsign: "DLH400", altitude: 35000, ground_speed: 450, track: 270,
  latitude: 47.1, longitude: -1.6, vertical_rate: 0, squawk: "1000", is_on_ground: false, timestamp: "",
  positions: [[47.1, -1.6, 35000]], first_seen: Date.now() - 60000, last_seen: Date.now() - 3000, message_count: 9,
};

const INFO: FlightInfo = {
  hex_ident: "3C6444", callsign: "DLH400", source: "web", stale: false, error: null, simulated: false,
  aircraft: {
    hex_ident: "3C6444", found: true, icao_type: "A319", type_name: "A319 112", manufacturer: "Airbus", registration: "D-AIBD",
    owner: "Lufthansa", owner_country: "Germany", photo_url: "https://image.airport-data.com/aircraft/1.jpg",
    photo_thumb_url: "https://airport-data.com/t.jpg", fetched_at_ms: 0,
  },
  route: {
    callsign: "DLH400", found: true, airline_name: "Lufthansa", airline_icao: "DLH", airline_iata: "LH", fetched_at_ms: 0,
    origin: { icao: "EDDF", iata: "FRA", name: "Frankfurt am Main Airport", city: "Frankfurt am Main", country: "Germany", latitude: 50, longitude: 8.5 },
    destination: { icao: "KJFK", iata: "JFK", name: "John F Kennedy International Airport", city: "New York", country: "United States", latitude: 40.6, longitude: -73.8 },
  },
};

function state(over: Partial<UseFlightInfo> = {}): UseFlightInfo {
  return { status: "idle", info: null, photo: null, error: null, request: vi.fn(), ...over };
}

function renderPanel(flightInfo: UseFlightInfo | undefined, isSimulated = false) {
  render(
    <AircraftDetailsPanel track={TRACK} isOpen width={280} onToggle={vi.fn()} onWidthChange={vi.fn()} flightInfo={flightInfo} isSimulated={isSimulated} />,
  );
}

beforeEach(() => {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));
});

describe("AircraftDetailsPanel flight info", () => {
  it("has no flight-info section without the prop", () => {
    renderPanel(undefined);
    expect(screen.queryByRole("button", { name: /show flight infos/i })).toBeNull();
  });

  it("asks only when the button is clicked", async () => {
    const s = state();
    renderPanel(s);
    expect(s.request).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /show flight infos/i }));
    expect(s.request).toHaveBeenCalledOnce();
  });

  it("disables the button for a simulated aircraft", async () => {
    const s = state();
    renderPanel(s, true);
    const button = screen.getByRole("button", { name: /show flight infos/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Not available for simulated flights");
  });

  it("shows loading while asking", () => {
    renderPanel(state({ status: "loading" }));
    expect(screen.getByRole("button", { name: /show flight infos/i })).toBeDisabled();
    expect(screen.getByText(/looking up/i)).toBeInTheDocument();
  });

  it("shows airline, route, aircraft and photo once loaded", () => {
    renderPanel(state({ status: "loaded", info: INFO, photo: "data:image/jpeg;base64,AAA" }));
    const section = screen.getByRole("region", { name: /flight info/i });
    expect(section).toHaveTextContent("Lufthansa");
    expect(section).toHaveTextContent("EDDF → KJFK");
    expect(screen.getByTitle("Frankfurt am Main Airport — Frankfurt am Main, Germany")).toHaveTextContent("EDDF");
    expect(section).toHaveTextContent("Airbus A319 112 · D-AIBD");
    expect(screen.getByRole("img", { name: /D-AIBD/ })).toHaveAttribute("src", "data:image/jpeg;base64,AAA");
    expect(screen.getByRole("link", { name: /airport-data\.com/i })).toHaveAttribute("href", INFO.aircraft!.photo_url);
    expect(screen.queryByRole("button", { name: /show flight infos/i })).toBeNull();
  });

  it("says when the route is unknown and hides the photo without one", () => {
    renderPanel(state({ status: "loaded", info: { ...INFO, route: { ...INFO.route!, found: false, origin: null, destination: null } } }));
    expect(screen.getByText(/no route known/i)).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("marks cached answers shown after a failed refresh", () => {
    renderPanel(state({ status: "loaded", info: { ...INFO, source: "cache", stale: true, error: "offline" } }));
    expect(screen.getByText(/offline \(cached\)/i)).toBeInTheDocument();
  });

  it("shows the error and lets the user retry", async () => {
    const s = state({ status: "error", error: "adsbdb unreachable" });
    renderPanel(s);
    expect(screen.getByText("adsbdb unreachable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /show flight infos/i }));
    expect(s.request).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it } from "vitest";
import { aircraftLabel, airportTitle, isSimulatedTrack, routeLabel } from "../flight-info";
import type { Airport, FlightRoute, AircraftInfo } from "../types";

const EDDF: Airport = { icao: "EDDF", iata: "FRA", name: "Frankfurt am Main Airport", city: "Frankfurt am Main", country: "Germany", latitude: 50.03, longitude: 8.57 };
const KJFK: Airport = { icao: "KJFK", iata: "JFK", name: "John F Kennedy International Airport", city: "New York", country: "United States", latitude: 40.64, longitude: -73.78 };

function route(over: Partial<FlightRoute> = {}): FlightRoute {
  return { callsign: "DLH400", found: true, airline_name: "Lufthansa", airline_icao: "DLH", airline_iata: "LH", origin: EDDF, destination: KJFK, fetched_at_ms: 0, ...over };
}

describe("isSimulatedTrack", () => {
  it("is true for a hex in either simulated list", () => {
    expect(isSimulatedTrack("ABC123", [{ hex_ident: "ABC123" }], [])).toBe(true);
    expect(isSimulatedTrack("abc123", [], [{ hex_ident: "ABC123" }])).toBe(true);
  });
  it("is false for a live aircraft or no selection", () => {
    expect(isSimulatedTrack("39BDA4", [{ hex_ident: "ABC123" }], [])).toBe(false);
    expect(isSimulatedTrack(null, [{ hex_ident: "ABC123" }], [])).toBe(false);
  });
});

describe("routeLabel", () => {
  it("joins the ICAO codes", () => {
    expect(routeLabel(route())).toBe("EDDF → KJFK");
  });
  it("shows a missing end as a question mark", () => {
    expect(routeLabel(route({ destination: null }))).toBe("EDDF → ?");
  });
  it("is null for an unknown route", () => {
    expect(routeLabel(route({ found: false, origin: null, destination: null }))).toBeNull();
    expect(routeLabel(null)).toBeNull();
  });
});

describe("airportTitle", () => {
  it("names the airport, its city and country", () => {
    expect(airportTitle(EDDF)).toBe("Frankfurt am Main Airport — Frankfurt am Main, Germany");
  });
  it("skips missing parts", () => {
    expect(airportTitle({ ...KJFK, city: null, country: null })).toBe("John F Kennedy International Airport");
    expect(airportTitle({ ...KJFK, name: null, city: null, country: null })).toBe("KJFK");
  });
});

describe("aircraftLabel", () => {
  const a: AircraftInfo = {
    hex_ident: "3C6444", found: true, icao_type: "A319", type_name: "A319 112", manufacturer: "Airbus",
    registration: "D-AIBD", owner: "Lufthansa", owner_country: "Germany", photo_url: null, photo_thumb_url: null, fetched_at_ms: 0,
  };
  it("gives manufacturer, type and registration", () => {
    expect(aircraftLabel(a)).toBe("Airbus A319 112 · D-AIBD");
  });
  it("falls back to the ICAO type, and is null when unknown", () => {
    expect(aircraftLabel({ ...a, manufacturer: null, type_name: null, registration: null })).toBe("A319");
    expect(aircraftLabel({ ...a, found: false })).toBeNull();
  });
});

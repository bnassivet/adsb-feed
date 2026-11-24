import { describe, expect, it } from "vitest";
import { aircraftLabel, airportTitle, canDrawRoute, flightPath, isSimulatedTrack, photoLink, routeAirports, routeDateLabel, routeLabel, sourceLabel } from "../flight-info";
import type { Airport, FlightRoute, AircraftInfo, FlightInfo } from "../types";

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
  it("lists the stops in order", () => {
    expect(routeLabel(route({ origin: YSSY, stops: [WSSS], destination: EGLL }))).toBe("YSSY → WSSS → EGLL");
  });
});

const YSSY: Airport = { icao: "YSSY", iata: "SYD", name: "Sydney", city: null, country: "AU", latitude: -33.9461, longitude: 151.177 };
const WSSS: Airport = { icao: "WSSS", iata: "SIN", name: "Singapore Changi Airport", city: null, country: "SG", latitude: 1.35019, longitude: 103.994 };
const EGLL: Airport = { icao: "EGLL", iata: "LHR", name: "London Heathrow Airport", city: null, country: "GB", latitude: 51.4775, longitude: -0.461389 };
const KLAX: Airport = { icao: "KLAX", iata: "LAX", name: "Los Angeles International Airport", city: null, country: "US", latitude: 33.9425, longitude: -118.408 };

describe("routeAirports", () => {
  it("is origin, stops, destination, keeping a missing end as null", () => {
    expect(routeAirports(route({ origin: YSSY, stops: [WSSS], destination: EGLL }))).toEqual([YSSY, WSSS, EGLL]);
    expect(routeAirports(route({ stops: undefined, destination: null }))).toEqual([EDDF, null]);
    expect(routeAirports(route({ found: false }))).toEqual([]);
  });
});

describe("flightPath", () => {
  it("draws one great-circle leg between consecutive airports", () => {
    const p = flightPath(route({ origin: YSSY, stops: [WSSS], destination: EGLL }))!;
    expect(p.airports.map((a) => a.airport.icao)).toEqual(["YSSY", "WSSS", "EGLL"]);
    expect(p.legs).toHaveLength(2);
    expect(p.legs[0][0]).toEqual([YSSY.latitude, YSSY.longitude]);
    expect(p.legs[0].at(-1)).toEqual([WSSS.latitude, WSSS.longitude]);
    expect(p.legs[1].at(-1)).toEqual([EGLL.latitude, EGLL.longitude]);
    expect(p.legs[0].length).toBeGreaterThan(2);
  });

  it("skips airports it cannot place", () => {
    const nowhere: Airport = { ...WSSS, latitude: null, longitude: null };
    const p = flightPath(route({ origin: YSSY, stops: [nowhere], destination: EGLL }))!;
    expect(p.airports.map((a) => a.airport.icao)).toEqual(["YSSY", "EGLL"]);
    expect(p.legs).toHaveLength(1);
  });

  it("keeps the line continuous across the antimeridian", () => {
    const p = flightPath(route({ origin: YSSY, destination: KLAX }))!;
    const lngs = p.legs.flat().map(([, lng]) => lng);
    for (let i = 1; i < lngs.length; i++) expect(Math.abs(lngs[i] - lngs[i - 1])).toBeLessThan(180);
    // The marker sits where the line ends, east of 180°.
    expect(p.airports[1].position[1]).toBeCloseTo(KLAX.longitude! + 360, 6);
    expect(p.legs[0].at(-1)![1]).toBeCloseTo(KLAX.longitude! + 360, 6);
  });

  it("is null with fewer than two placed airports or no route", () => {
    expect(flightPath(route({ destination: null }))).toBeNull();
    expect(flightPath(route({ found: false }))).toBeNull();
    expect(flightPath(null)).toBeNull();
  });
});

describe("routeDateLabel", () => {
  it("gives the source's update date as a day", () => {
    expect(routeDateLabel(route({ updated_at: "2019-06-06T04:34:58Z" }))).toBe("Route data of 2019-06-06");
  });
  it("is null without a date", () => {
    expect(routeDateLabel(route())).toBeNull();
    expect(routeDateLabel(route({ updated_at: "garbage" }))).toBeNull();
    expect(routeDateLabel(null)).toBeNull();
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

function airframe(over: Partial<AircraftInfo> = {}): AircraftInfo {
  return {
    hex_ident: "3C6444", found: true, icao_type: "A319", type_name: "A319 112", manufacturer: "Airbus", registration: "D-AIBD",
    owner: null, owner_country: null, photo_url: null, photo_thumb_url: null, fetched_at_ms: 0, ...over,
  };
}

function info(aircraft: AircraftInfo | null, r: FlightRoute | null): FlightInfo {
  return { hex_ident: "3C6444", callsign: "DLH400", aircraft, route: r, source: "web", stale: false, error: null, simulated: false };
}

describe("sourceLabel", () => {
  it("names every source asked, as the backend reports them", () => {
    // ECC602: hexdb and adsbdb asked for both parts; only adsbdb knew the route.
    const ecc: FlightInfo = { ...info(airframe({ found: false }), route({ provider: "adsbdb", airline_name: null })), sources: ["adsbdb", "hexdb"] };
    expect(sourceLabel(ecc)).toBe("adsbdb.com + hexdb.io");
    expect(sourceLabel({ ...info(airframe({ provider: "adsbdb" }), null), sources: ["adsbdb"] })).toBe("adsbdb.com");
  });

  it("names adsbdb for its answers and for rows cached before the provider tag", () => {
    expect(sourceLabel(info(airframe({ provider: "adsbdb" }), route({ provider: "adsbdb" })))).toBe("adsbdb.com");
    expect(sourceLabel(info(airframe(), route()))).toBe("adsbdb.com");
  });

  it("names hexdb when the fallback answered", () => {
    expect(sourceLabel(info(airframe({ provider: "hexdb" }), null))).toBe("hexdb.io");
  });

  it("names both when each answered a part", () => {
    expect(sourceLabel(info(airframe({ provider: "hexdb" }), route({ provider: "adsbdb" })))).toBe("adsbdb.com + hexdb.io");
  });

  it("names both when neither knew anything, since both were asked", () => {
    expect(sourceLabel(info(airframe({ found: false }), route({ found: false })))).toBe("adsbdb.com + hexdb.io");
  });
});

describe("photoLink", () => {
  it("links the full photo and names its host", () => {
    expect(photoLink(airframe({ photo_url: "https://image.airport-data.com/aircraft/1.jpg", photo_thumb_url: "https://airport-data.com/t.jpg" })))
      .toEqual({ href: "https://image.airport-data.com/aircraft/1.jpg", host: "image.airport-data.com" });
  });

  it("falls back to the thumbnail when there is no full photo (hexdb)", () => {
    const t = "https://hexdb.io/static/aircraft-images/EI-DCL-thumb.jpg";
    expect(photoLink(airframe({ photo_thumb_url: t }))).toEqual({ href: t, host: "hexdb.io" });
  });

  it("is null without a usable link", () => {
    expect(photoLink(null)).toBeNull();
    expect(photoLink(airframe())).toBeNull();
    expect(photoLink(airframe({ photo_url: "not a url" }))).toBeNull();
  });
});

describe("canDrawRoute", () => {
  it("is true with two airports that have a position", () => {
    expect(canDrawRoute(route())).toBe(true);
  });
  it("is false otherwise", () => {
    expect(canDrawRoute(route({ destination: null }))).toBe(false);
    expect(canDrawRoute(route({ destination: { ...KJFK, latitude: null } }))).toBe(false);
    expect(canDrawRoute(route({ found: false }))).toBe(false);
    expect(canDrawRoute(null)).toBe(false);
  });
});

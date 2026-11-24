/** Pure helpers for the "Show Flight Infos" section of the details panel. */
import { greatCirclePoints, type LatLng } from "./range-line";
import type { AircraftInfo, Airport, FlightInfo, FlightRoute } from "./types";

/**
 * Whether the selected hex belongs to a simulated aircraft (demo flights or
 * agent trajectories). Tracks carry no flag of their own, so membership in the
 * simulated lists is the only test — and simulated identities must never be
 * sent to a web service.
 */
export function isSimulatedTrack(
  hex: string | null | undefined,
  ...simulated: ReadonlyArray<ReadonlyArray<{ hex_ident: string }>>
): boolean {
  if (!hex) return false;
  const h = hex.toUpperCase();
  return simulated.some((list) => list.some((t) => t.hex_ident.toUpperCase() === h));
}

/** Origin, stops, destination in order; a missing end stays `null`. Empty when the route is unknown. */
export function routeAirports(route: FlightRoute | null | undefined): (Airport | null)[] {
  if (!route?.found) return [];
  return [route.origin, ...(route.stops ?? []), route.destination];
}

/** "YSSY → WSSS → EGLL"; a missing end is "?"; null when the route is unknown. */
export function routeLabel(route: FlightRoute | null | undefined): string | null {
  if (!route?.found || (!route.origin && !route.destination)) return null;
  return routeAirports(route)
    .map((a) => a?.icao ?? "?")
    .join(" → ");
}

/** "Route data of 2019-06-06" from the source's update time; null without one. */
export function routeDateLabel(route: FlightRoute | null | undefined): string | null {
  const day = route?.updated_at?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return day ? `Route data of ${day}` : null;
}

function placed(a: Airport | null): a is Airport {
  return a != null && a.latitude != null && a.longitude != null;
}

/** Whether `flightPath` would draw anything: two airports with a position. */
export function canDrawRoute(route: FlightRoute | null | undefined): boolean {
  return routeAirports(route).filter(placed).length >= 2;
}

/** A route ready to draw: the airports that can be placed, and one great-circle leg between each pair. */
export interface FlightPath {
  airports: { airport: Airport; position: LatLng }[];
  legs: LatLng[][];
}

/**
 * The selected flight's route as map geometry, or null with fewer than two
 * placeable airports. Longitudes are unwrapped along the whole path (they may
 * leave [-180, 180]) so a leg across the antimeridian is drawn the short way
 * instead of across the whole map; markers use the same longitudes as the line.
 */
export function flightPath(route: FlightRoute | null | undefined): FlightPath | null {
  const airports = routeAirports(route).filter(placed);
  if (airports.length < 2) return null;
  let last = airports[0].longitude!;
  const unwrap = ([lat, lng]: LatLng): LatLng => {
    while (lng - last > 180) lng -= 360;
    while (lng - last < -180) lng += 360;
    last = lng;
    return [lat, lng];
  };
  const legs: LatLng[][] = [];
  for (let i = 1; i < airports.length; i++) {
    const from: LatLng = [airports[i - 1].latitude!, airports[i - 1].longitude!];
    const to: LatLng = [airports[i].latitude!, airports[i].longitude!];
    legs.push(greatCirclePoints(from, to, 64).map(unwrap));
  }
  const positions = [legs[0][0], ...legs.map((leg) => leg[leg.length - 1])];
  return { airports: airports.map((airport, i) => ({ airport, position: positions[i] })), legs };
}

/** Hover text for an airport: "Name — City, Country", skipping missing parts. */
export function airportTitle(a: Airport): string {
  const place = [a.city, a.country].filter(Boolean).join(", ");
  const name = a.name ?? a.icao;
  return place ? `${name} — ${place}` : name;
}

/** "Airbus A319 112 · D-AIBD"; null when the airframe is unknown. */
export function aircraftLabel(a: AircraftInfo | null | undefined): string | null {
  if (!a?.found) return null;
  const type = [a.manufacturer, a.type_name ?? a.icao_type].filter(Boolean).join(" ");
  const label = [type, a.registration].filter(Boolean).join(" · ");
  return label || null;
}

const SOURCE_SITES: Record<string, string> = { adsbdb: "adsbdb.com", hexdb: "hexdb.io" };

/**
 * Every web source asked for an answer, for the section's footer, whether or
 * not it knew anything. The backend reports them (`sources`); without that,
 * the sources that answered, and both when neither part was known.
 */
export function sourceLabel(info: FlightInfo): string {
  const parts = [info.aircraft, info.route].filter((p) => p?.found);
  const providers = info.sources?.length
    ? info.sources
    : parts.length === 0
      ? ["adsbdb", "hexdb"]
      : parts.map((p) => p?.provider ?? "adsbdb");
  const sites = [...new Set(providers.map((p) => SOURCE_SITES[p] ?? p))].sort();
  return sites.join(" + ");
}

/** Where the photo credit links: the full photo, else the thumbnail (hexdb has only that). */
export function photoLink(a: AircraftInfo | null | undefined): { href: string; host: string } | null {
  const href = a?.photo_url ?? a?.photo_thumb_url;
  if (!href) return null;
  try {
    return { href, host: new URL(href).hostname };
  } catch {
    return null;
  }
}

/** Pure helpers for the "Show Flight Infos" section of the details panel. */
import type { AircraftInfo, Airport, FlightRoute } from "./types";

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

/** "EDDF → KJFK"; a missing end is "?"; null when the route is unknown. */
export function routeLabel(route: FlightRoute | null | undefined): string | null {
  if (!route?.found || (!route.origin && !route.destination)) return null;
  return `${route.origin?.icao ?? "?"} → ${route.destination?.icao ?? "?"}`;
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

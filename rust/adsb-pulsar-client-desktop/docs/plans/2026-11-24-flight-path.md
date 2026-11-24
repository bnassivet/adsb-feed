# Flight path on the map (hexdb routes, airports)

## Context
Follows `2026-11-24-hexdb-fallback.md`. hexdb's `/api/v2/routes/{callsign}` is richer than adsbdb's: it lists every stop (QFA1 YSSY → WSSS → EGLL) and carries `updated_at`. adsbdb sometimes has a `midpoint`, and its data can be out of date (QFA9). Goal: show the selected aircraft's route on the map, as great-circle legs through every stop with a marker at each airport.

Decisions (user, 2026-11-24):
- **Routes: hexdb first, adsbdb as fallback.** Same rule as for airframes: only "unknown" (404) falls back.
- **Airline from the airframe.** hexdb routes have no airline. The hexdb (and adsbdb) aircraft record has `registered_owner` and `operator_flag_code` (`easyJet UK`, `EZY`). When the route has no airline, the callsign starts with that operator code and the airframe is known, the owner is shown as the airline. This is derived per lookup, never stored on the route.
- **`/api/v2/airports/{icao}` only fills gaps.** Any airport of a route without coordinates is resolved through it and cached in a new DuckDB `airports` table for 30 days. A failure leaves the code alone.
- **Map:** a dashed great-circle line origin → stops → destination plus an airport marker with a name tooltip. It shows for the selected aircraft once "Show Flight Infos" has loaded a route, and disappears with the selection.

## Changes
- `adsb-data-engine`:
  - `AircraftInfo.operator_icao`.
  - `FlightRoute.stops: Vec<Airport>` (intermediate) and `FlightRoute.updated_at: Option<String>`.
  - Columns `aircraft_info.operator_icao`, `flight_routes.stops_json`, `flight_routes.updated_at`, added by `ADD COLUMN IF NOT EXISTS`.
  - Table `airports`, with `get_airport_sync` / `upsert_airport_sync`.
- `flight_info.rs`:
  - Per-part source order: airframe `[adsbdb, hexdb]`, route `[hexdb, adsbdb]`.
  - A cached "unknown" is fresh only if the *last* source gave it. Otherwise the sources not yet asked are asked at once; NULL provider means adsbdb.
  - Parse adsbdb `midpoint` and hexdb `airports[1..n-1]` into `stops`.
  - Fill coordinates; derive the airline.
- Desktop:
  - `flightPath(route)` in `lib/flight-info.ts`: airports with coordinates and legs built with `greatCirclePoints`, longitudes unwrapped across the antimeridian.
  - `routeLabel` shows the stops; the panel shows "route data of <date>".
  - `MapInner` gets a `flightPath` prop; `page.tsx` derives it from `selectedFlightInfo`.
- Agent: the `lookupFlightInfo` description mentions stops.

## Verification
- `cargo test --workspace`, clippy (also with `web-lookup`), fmt.
- `npm test`, `npm run lint`, `npx tsc --noEmit` (the error count must not grow).
- Manual check in `tauri dev`: select a long-haul aircraft, click Show Flight Infos, and see the path and the airports.

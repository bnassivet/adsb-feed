"use client";
import type { UseFlightInfo } from "@/hooks/useFlightInfo";
import { Fragment } from "react";
import { EyeIcon } from "@/components/EyeIcon";
import { flightPathTitle } from "@/components/FlightPathButton";
import { aircraftLabel, airportTitle, canDrawRoute, photoLink, routeAirports, routeDateLabel, routeLabel, sourceLabel } from "@/lib/flight-info";
import type { Airport } from "@/lib/types";

const SIMULATED_TITLE = "Not available for simulated flights";

function AirportCode({ airport }: { airport: Airport | null }) {
  if (!airport) return <span>?</span>;
  return (
    <span title={airportTitle(airport)} className="underline decoration-dotted decoration-slate-500 cursor-help">
      {airport.icao}
    </span>
  );
}

/**
 * Airline, route, airframe and photo from the web (adsbdb, with hexdb.io as
 * the fallback for what adsbdb does not know), shown under the
 * aircraft's identity. Nothing is asked until "Show Flight Infos" is clicked,
 * and the button is disabled for simulated aircraft.
 */
export function FlightInfoSection({
  flightInfo,
  isSimulated,
  flightPathShown = true,
  onToggleFlightPath,
}: {
  flightInfo: UseFlightInfo;
  isSimulated: boolean;
  /** Whether the route's great-circle path is drawn on the map. */
  flightPathShown?: boolean;
  /** Show/hide the path; the eye is offered only with a handler and a drawable route. */
  onToggleFlightPath?: () => void;
}) {
  const { status, info, photo, error, request } = flightInfo;
  const route = info?.route ?? null;
  const routeText = routeLabel(route);
  const aircraft = info?.aircraft ?? null;
  const airframe = aircraftLabel(aircraft);
  const credit = photoLink(aircraft);

  return (
    <section aria-label="Flight info" className="px-3 py-2 border-b border-slate-800 space-y-1 text-xs">
      {status !== "loaded" && (
        <button
          onClick={request}
          disabled={isSimulated || status === "loading"}
          title={isSimulated ? SIMULATED_TITLE : "Look up route, airline and aircraft on adsbdb.com (hexdb.io as fallback)"}
          className="px-2 py-1 rounded bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          Show Flight Infos
        </button>
      )}
      {status === "loading" && <div className="text-slate-500">Looking up…</div>}
      {status === "error" && error && <div className="text-amber-400">{error}</div>}
      {status === "loaded" && info && (
        <>
          {route?.found && route.airline_name && <div className="text-slate-200 font-medium">{route.airline_name}</div>}
          {routeText ? (
            <div className="flex items-center gap-2">
              <div className="font-mono text-slate-100">
                {routeAirports(route).map((a, i) => (
                  <Fragment key={i}>
                    {i > 0 && " → "}
                    <AirportCode airport={a} />
                  </Fragment>
                ))}
              </div>
              {onToggleFlightPath && canDrawRoute(route) && (
                <button
                  onClick={onToggleFlightPath}
                  aria-label={flightPathTitle({ active: flightPathShown, hasRoute: true })}
                  title={flightPathTitle({ active: flightPathShown, hasRoute: true })}
                  className={`ml-auto leading-none transition ${flightPathShown ? "text-amber-400 hover:text-amber-300" : "text-slate-600 hover:text-slate-300"}`}
                >
                  <EyeIcon open={flightPathShown} />
                </button>
              )}
            </div>
          ) : (
            <div className="text-slate-500">{info.callsign ? "No route known" : "No callsign: no route"}</div>
          )}
          {routeText && routeDateLabel(route) && <div className="text-[10px] text-slate-500">{routeDateLabel(route)}</div>}
          {airframe ? (
            <div className="text-slate-300">{airframe}</div>
          ) : (
            <div className="text-slate-500">Aircraft not in the database</div>
          )}
          {aircraft?.found && aircraft.owner && aircraft.owner !== route?.airline_name && (
            <div className="text-slate-400">{aircraft.owner}</div>
          )}
          {photo && aircraft && (
            <figure className="pt-1">
              {/* A data: URL in a static export: next/image has nothing to optimise. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo} alt={`Photo of ${aircraft.registration ?? info.hex_ident}`} className="w-full rounded" />
              {credit && (
                <figcaption className="text-[10px] text-slate-500">
                  Photo:{" "}
                  <a href={credit.href} target="_blank" rel="noreferrer" className="underline">
                    {credit.host}
                  </a>
                </figcaption>
              )}
            </figure>
          )}
          {info.stale && <div className="text-amber-400">offline (cached)</div>}
          {!info.stale && info.error && <div className="text-amber-400">{info.error}</div>}
          <div className="text-[10px] text-slate-600">Source: {sourceLabel(info)} · not a filed flight plan</div>
        </>
      )}
    </section>
  );
}

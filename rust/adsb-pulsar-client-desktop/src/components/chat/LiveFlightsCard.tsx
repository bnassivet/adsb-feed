"use client";
/**
 * Chat card rendering live flight search results from searchLiveFlights tool call.
 * Displays a compact table of currently active aircraft with key telemetry data.
 */
import { ChatCard } from "./ChatCard";

interface FlightRow {
  hex_ident: string;
  callsign: string | null;
  altitude: number | null;
  ground_speed: number | null;
  track: number | null;
  latitude: number | null;
  longitude: number | null;
  squawk: string | null;
  is_on_ground: boolean | null;
}

interface FlightResult {
  total: number;
  showing: number;
  flights: FlightRow[];
}

interface Props {
  status: "in_progress" | "executing" | "complete";
  result?: string;
}

/** Map a heading in degrees to a single arrow character. */
function headingArrow(deg: number): string {
  const arrows = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return arrows[idx];
}

export function LiveFlightsCard({ status, result }: Props) {
  let flights: FlightRow[] = [];
  let total = 0;
  let showing = 0;

  if (status === "complete" && result) {
    try {
      const parsed = JSON.parse(result) as FlightResult;
      flights = parsed.flights ?? [];
      total = parsed.total ?? 0;
      showing = parsed.showing ?? flights.length;
    } catch { /* ignore */ }
  }

  return (
    <ChatCard title={`Live Flights (${showing}/${total})`} icon="📡" status={status}>
      {flights.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 border-b border-slate-700">
                <th className="text-left py-1 pr-2">Hex</th>
                <th className="text-left py-1 pr-2">Callsign</th>
                <th className="text-right py-1 pr-2">Alt</th>
                <th className="text-right py-1 pr-2">Spd</th>
                <th className="text-right py-1 pr-2">Hdg</th>
                <th className="text-left py-1 pr-2">Sqk</th>
                <th className="text-center py-1">Gnd</th>
              </tr>
            </thead>
            <tbody>
              {flights.map((f) => (
                <tr key={f.hex_ident} className="text-slate-200 border-b border-slate-700/50">
                  <td className="py-0.5 pr-2 font-mono text-violet-300">{f.hex_ident}</td>
                  <td className="py-0.5 pr-2">{f.callsign ?? "—"}</td>
                  <td className="py-0.5 pr-2 text-right font-mono">
                    {f.altitude != null ? `${f.altitude.toLocaleString()} ft` : "—"}
                  </td>
                  <td className="py-0.5 pr-2 text-right font-mono">
                    {f.ground_speed != null ? `${f.ground_speed} kts` : "—"}
                  </td>
                  <td className="py-0.5 pr-2 text-right font-mono">
                    {f.track != null ? `${headingArrow(f.track)} ${Math.round(f.track)}°` : "—"}
                  </td>
                  <td className="py-0.5 pr-2 font-mono">
                    {f.squawk ?? "—"}
                  </td>
                  <td className="py-0.5 text-center">
                    {f.is_on_ground === true ? "🔵" : f.is_on_ground === false ? "✈️" : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {showing < total && (
            <p className="text-xs text-slate-400 mt-1">
              Showing {showing} of {total} flights. Narrow your search for more specific results.
            </p>
          )}
        </div>
      ) : (
        status === "complete" && (
          <p className="text-xs text-slate-400">No flights match the search criteria.</p>
        )
      )}
    </ChatCard>
  );
}

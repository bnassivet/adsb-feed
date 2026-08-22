"use client";
/**
 * Chat card for the listScenarios / getScenario tools.
 *
 * Handles both shapes: a list of saved scenarios, and one opened scenario with
 * its tracks. Also renders the `{ error }` shape the tools return when the
 * scenario layer or the database is unavailable — that is a normal outcome
 * here, not a failure worth an empty card.
 */
import { ChatCard } from "./ChatCard";

interface ScenarioRow {
  id: string;
  name: string;
  trackCount: number;
  updatedAtMs: number;
}

interface TrackRow {
  trackId: string;
  callsign: string;
  category: string;
  startOffsetS: number;
}

interface Parsed {
  error?: string;
  scenarios?: ScenarioRow[];
  activeScenarioId?: string | null;
  id?: string;
  name?: string;
  description?: string;
  tracks?: TrackRow[];
}

/** `m:ss`, matching the panel's own clock readout. */
function formatOffset(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${(safe % 60).toString().padStart(2, "0")}`;
}

interface Props {
  status: "in_progress" | "executing" | "complete";
  result?: string;
}

export function ScenarioCard({ status, result }: Props) {
  let parsed: Parsed = {};
  if (status === "complete" && result) {
    try {
      parsed = JSON.parse(result) as Parsed;
    } catch {
      /* leave empty — the card still renders its title and status */
    }
  }

  const { error, scenarios, activeScenarioId, name, description, tracks } = parsed;

  const title = tracks
    ? `Scenario: ${name ?? "—"}`
    : `Scenarios (${scenarios?.length ?? 0})`;

  return (
    <ChatCard title={title} icon="🎬" status={status}>
      {error && <p className="text-xs text-amber-400">{error}</p>}

      {/* Above the track table: the description is what the scenario *is*,
          the tracks are the detail. Empty descriptions render nothing. */}
      {description && (
        <p className="text-xs text-slate-300 italic mb-1.5">{description}</p>
      )}

      {scenarios && scenarios.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 border-b border-slate-700">
                <th className="text-left py-1 pr-2">Name</th>
                <th className="text-right py-1">Tracks</th>
              </tr>
            </thead>
            <tbody>
              {scenarios.map((s) => (
                <tr key={s.id} className="text-slate-200 border-b border-slate-700/50">
                  <td className="py-0.5 pr-2 font-medium text-emerald-300">
                    {s.name}
                    {s.id === activeScenarioId && (
                      <span className="ml-1 text-[10px] text-slate-500">active</span>
                    )}
                  </td>
                  <td className="py-0.5 text-right text-slate-400">{s.trackCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {scenarios && scenarios.length === 0 && !error && (
        <p className="text-xs text-slate-400">No scenarios saved yet.</p>
      )}

      {tracks && tracks.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 border-b border-slate-700">
                <th className="text-left py-1 pr-2">Callsign</th>
                <th className="text-left py-1 pr-2">Type</th>
                <th className="text-right py-1">Enters at</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((t) => (
                <tr key={t.trackId} className="text-slate-200 border-b border-slate-700/50">
                  <td className="py-0.5 pr-2 font-medium text-emerald-300">{t.callsign}</td>
                  <td className="py-0.5 pr-2 text-slate-400">{t.category}</td>
                  <td className="py-0.5 text-right text-slate-400 font-mono tabular-nums">
                    {formatOffset(t.startOffsetS)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tracks && tracks.length === 0 && !error && (
        <p className="text-xs text-slate-400">This scenario has no tracks yet.</p>
      )}
    </ChatCard>
  );
}

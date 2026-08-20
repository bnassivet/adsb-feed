"use client";
/**
 * Simulation Agent tab: generate trajectories, list them, and drive playback.
 *
 * Generation talks to `POST /simulate/trajectory` on adsb-agent, which shares
 * its A2A client with the `generateSimulatedTrajectory` chat tool — a form
 * submission and a chat request produce identical results.
 *
 * Generated aircraft arrive **stopped**; nothing moves until the user presses
 * Start. Each has its own clock, so they run independently.
 *
 * These controls affect ONLY agent-generated trajectories. The 20 hardcoded
 * demo flights are a separate source behind the Filters "simulation" toggle —
 * the two were briefly coupled, which made Start here launch all 20.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { simulateTrajectory, type SimulateRequest } from "@/lib/simulate-api";
import { summarizeTrajectory, type AgentTrajectory } from "@/lib/simulation-data";
import {
  formatClock,
  progressOf,
  trajectoryDurationS,
  type PlaybackEntry,
  type PlaybackMap,
} from "@/lib/trajectory-playback";

const CATEGORIES = [
  { value: "helicopter", label: "Helicopter" },
  { value: "ga", label: "General Aviation" },
  { value: "airliner", label: "Airliner" },
  { value: "fighter", label: "Fighter" },
] as const;

type Category = (typeof CATEGORIES)[number]["value"];

const STATE_STYLE: Record<string, { dot: string; label: string }> = {
  playing: { dot: "bg-emerald-400", label: "playing" },
  paused: { dot: "bg-amber-400", label: "paused" },
  stopped: { dot: "bg-slate-600", label: "stopped" },
};

/**
 * Scenario wiring, supplied by `page.tsx`.
 *
 * Optional so the panel still works — and still tests — as a pure generator
 * when there is no scenario layer, which is also what the user gets by choosing
 * "No scenario" in the bar.
 */
export interface ScenarioIntegration {
  bar: ReactNode;
  /** hex_idents already saved in the active scenario, keyed by track id. */
  savedTrackIds: Record<string, string>;
  /** Start offsets of saved tracks, by hex_ident. */
  offsetsByHex: Record<string, number>;
  /** Null when no scenario is selected — "+ Add" is then unavailable. */
  activeScenarioId: string | null;
  /**
   * `request` is the `SimulateRequest` this panel generated the trajectory
   * from, or `null` when the panel did not generate it (a chat-generated
   * aircraft arrives as a prop with no request attached). It is persisted as
   * the track's `request_json`, which is where the route hint — the best
   * description of what the aircraft actually does — survives.
   */
  onAddToScenario: (trajectory: AgentTrajectory, request: SimulateRequest | null) => void;
  onRemoveFromScenario: (trackId: string) => void;
  onOffsetChange: (trackId: string, startOffsetS: number) => void;
}

interface Props {
  receiverLocation: { lat: number; lng: number } | null;
  trajectories: AgentTrajectory[];
  onTrajectories: (trajectories: AgentTrajectory[]) => void;
  playback: PlaybackMap;
  onStart: (ids: string[]) => void;
  onPause: (ids: string[]) => void;
  onResume: (ids: string[]) => void;
  onStop: (ids: string[]) => void;
  onSeek: (id: string, elapsedS: number) => void;
  scenario?: ScenarioIntegration;
}

export function SimulationPanel({
  receiverLocation,
  trajectories,
  onTrajectories,
  playback,
  onStart,
  onPause,
  onResume,
  onStop,
  onSeek,
  scenario,
}: Props) {
  const [category, setCategory] = useState<Category>("helicopter");
  // Held as text so the field can be emptied while typing. Coercing on every
  // keystroke would turn a cleared field into "1" and make the next digit
  // read as "1x".
  const [countText, setCountText] = useState("1");
  const [routeHint, setRouteHint] = useState("");
  /*
   * The request this panel last generated from, and the callsigns it produced.
   *
   * Kept so "+ Add to scenario" can persist it as the track's `request_json`:
   * the route hint is the best description of what an aircraft does and is not
   * recoverable from its waypoints.
   *
   * Scoped by *callsign*, not `hex_ident`, and that matters — `page.tsx` runs
   * incoming aircraft through `stageTrajectories`, which reassigns a colliding
   * hex, so the ids coming back as props need not be the ones we sent up.
   * Callsigns are left alone. Scoping it at all is the point: chat-generated
   * aircraft land in the same list, and attaching this panel's route hint to
   * one of those would describe it as something it is not.
   */
  const [lastRequest, setLastRequest] = useState<{
    request: SimulateRequest;
    callsigns: Set<string>;
  } | null>(null);
  const [altitude, setAltitude] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const handleGenerate = useCallback(async () => {
    if (!receiverLocation) return;
    setBusy(true);
    setError(null);
    try {
      const parsedAltitude = altitude.trim() ? Number(altitude) : undefined;
      const count = Math.max(1, Math.min(20, parseInt(countText, 10) || 1));
      const request: SimulateRequest = {
        category,
        originLat: receiverLocation.lat,
        originLng: receiverLocation.lng,
        count,
        routeHint: routeHint.trim() || undefined,
        cruiseAltitudeFt: Number.isFinite(parsedAltitude) ? parsedAltitude : undefined,
      };
      const result = await simulateTrajectory(request);
      // Selection is handled by the arrival rule below, which covers the chat
      // path too — this only has to hand the aircraft up.
      onTrajectories(result.aircraft);
      // Only after a successful call: a failed generation must not leave a
      // request attached to whatever is still listed from before.
      setLastRequest({
        request,
        callsigns: new Set(result.aircraft.map((a) => a.callsign)),
      });
      setSummary(result.summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSummary(null);
    } finally {
      setBusy(false);
    }
  }, [category, countText, routeHint, altitude, receiverLocation, onTrajectories]);

  const handleClear = useCallback(() => {
    onTrajectories([]);
    setSelected(new Set());
    setSummary(null);
    setError(null);
    setLastRequest(null);
  }, [onTrajectories]);

  /*
   * Select trajectories as they arrive, whichever path produced them.
   *
   * Every transport button acts on `selected` alone, so an unselected
   * trajectory is inert. The form used to select its own results, but chat
   * results arrive as props and were selected by nobody — they landed in the
   * list with Start, Pause and Stop all doing nothing. Keying on *new* ids
   * rather than re-selecting everything means a deliberate deselection sticks.
   *
   * Render-phase adjust-state (the pattern used in page.tsx) rather than an
   * effect: no second commit, and the first paint already shows them selected.
   */
  const signature = trajectories.map((t) => t.hex_ident).join("|");
  // Starts empty, not at `signature`, so trajectories already present on the
  // first render count as arrivals too — the panel can be mounted after the
  // chat has already produced aircraft.
  const [prevSignature, setPrevSignature] = useState("");
  if (signature !== prevSignature) {
    setPrevSignature(signature);
    const known = new Set(prevSignature ? prevSignature.split("|") : []);
    const present = new Set(trajectories.map((t) => t.hex_ident));
    setSelected((prev) => {
      const next = new Set<string>();
      // Keep existing choices, dropping trajectories that are gone…
      for (const id of prev) if (present.has(id)) next.add(id);
      // …and adopt anything the panel has not seen before.
      for (const id of present) if (!known.has(id)) next.add(id);
      return next;
    });
  }

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected =
    trajectories.length > 0 && trajectories.every((t) => selected.has(t.hex_ident));

  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(trajectories.map((t) => t.hex_ident)));
  }, [allSelected, trajectories]);

  const selectedIds = useMemo(
    () => trajectories.map((t) => t.hex_ident).filter((id) => selected.has(id)),
    [trajectories, selected],
  );

  // Clear discards only the *unsaved* results, so it must be disabled when
  // everything on screen is already saved in the scenario — otherwise the
  // button looks live but does nothing.
  const hasStaged = scenario
    ? trajectories.some((t) => !scenario.savedTrackIds[t.hex_ident])
    : trajectories.length > 0;

  // Which transport actions make sense for the current selection.
  const states = selectedIds.map((id) => playback[id]?.state ?? "stopped");
  const canStart = states.some((s) => s === "stopped");
  const canPause = states.some((s) => s === "playing");
  const canResume = states.some((s) => s === "paused");
  const canStop = states.some((s) => s !== "stopped");

  return (
    <div className="flex flex-col gap-3 p-4">
      {scenario?.bar}

      <div className="text-xs text-slate-400">
        Generate simulated aircraft with realistic flight dynamics around the
        receiver.
      </div>

      {!receiverLocation && (
        <div className="text-xs text-amber-400">
          Set a receiver location first — generated routes are built around it.
        </div>
      )}

      <div>
        <label htmlFor="sim-category" className="block text-xs text-slate-400 mb-1">
          Aircraft type
        </label>
        <select
          id="sim-category"
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
          className="w-full px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 focus:border-blue-500 focus:outline-none"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="sim-count" className="block text-xs text-slate-400 mb-1">
          How many
        </label>
        <input
          id="sim-count"
          type="number"
          min={1}
          max={20}
          value={countText}
          onChange={(e) => setCountText(e.target.value)}
          className="w-full px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 focus:border-blue-500 focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="sim-hint" className="block text-xs text-slate-400 mb-1">
          Route description <span className="text-slate-500">(optional)</span>
        </label>
        <input
          id="sim-hint"
          type="text"
          value={routeHint}
          onChange={(e) => setRouteHint(e.target.value)}
          placeholder="circling the port, final approach from the west…"
          className="w-full px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="sim-alt" className="block text-xs text-slate-400 mb-1">
          Altitude ft <span className="text-slate-500">(optional)</span>
        </label>
        <input
          id="sim-alt"
          type="number"
          min={0}
          max={60000}
          value={altitude}
          onChange={(e) => setAltitude(e.target.value)}
          placeholder="auto"
          className="w-full px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
        />
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={busy || !receiverLocation}
          className="flex-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 rounded text-sm text-white font-medium transition-colors"
        >
          {busy ? "Generating…" : "Generate"}
        </button>
        <button
          type="button"
          onClick={handleClear}
          disabled={!hasStaged}
          title={scenario ? "Discard the unsaved generated trajectories" : undefined}
          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 rounded text-sm text-slate-200 transition-colors"
        >
          Clear
        </button>
      </div>

      {error && (
        <div role="alert" className="text-xs text-red-400 break-words">
          {error}
        </div>
      )}

      {summary && !error && <div className="text-xs text-slate-400">{summary}</div>}

      {trajectories.length > 0 && (
        <>
          <div className="flex items-center justify-between border-t border-slate-700 pt-2">
            <span className="text-xs font-semibold text-slate-400">
              Trajectories{" "}
              <span className="font-mono text-slate-500">({trajectories.length})</span>
            </span>
            <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="accent-blue-500"
                aria-label="Select all trajectories"
              />
              All
            </label>
          </div>

          <ul className="flex flex-col gap-2 list-none m-0 p-0">
            {trajectories.map((trajectory) => (
              <TrajectoryRow
                key={trajectory.hex_ident}
                trajectory={trajectory}
                entry={playback[trajectory.hex_ident]}
                selected={selected.has(trajectory.hex_ident)}
                onToggle={() => toggleOne(trajectory.hex_ident)}
                onSeek={onSeek}
                scenario={scenario}
                savedTrackId={scenario?.savedTrackIds[trajectory.hex_ident]}
                generatedRequest={
                  lastRequest?.callsigns.has(trajectory.callsign)
                    ? lastRequest.request
                    : null
                }
              />
            ))}
          </ul>

          <div
            className="grid grid-cols-4 gap-1.5"
            role="group"
            aria-label="Playback controls"
          >
            <TransportButton label="Start" onClick={() => onStart(selectedIds)} disabled={!canStart} />
            <TransportButton label="Pause" onClick={() => onPause(selectedIds)} disabled={!canPause} />
            <TransportButton label="Resume" onClick={() => onResume(selectedIds)} disabled={!canResume} />
            <TransportButton label="Stop" onClick={() => onStop(selectedIds)} disabled={!canStop} />
          </div>

          {selectedIds.length === 0 && (
            <div className="text-xs text-slate-500">
              Select a trajectory to control its playback.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TransportButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-2 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 rounded text-xs text-slate-200 transition-colors"
    >
      {label}
    </button>
  );
}

function TrajectoryRow({
  trajectory,
  entry,
  selected,
  onToggle,
  onSeek,
  scenario,
  savedTrackId,
  generatedRequest,
}: {
  trajectory: AgentTrajectory;
  entry: PlaybackEntry | undefined;
  selected: boolean;
  onToggle: () => void;
  onSeek: (id: string, elapsedS: number) => void;
  scenario?: ScenarioIntegration;
  /** Present when this trajectory is saved in the active scenario. */
  savedTrackId?: string;
  /** The request that generated this aircraft, when this panel generated it. */
  generatedRequest: SimulateRequest | null;
}) {
  const summary = useMemo(() => summarizeTrajectory(trajectory), [trajectory]);
  const duration = trajectoryDurationS(trajectory);
  const state = entry?.state ?? "stopped";
  const style = STATE_STYLE[state];
  const elapsed = entry?.elapsedS ?? 0;
  const label = trajectory.callsign || trajectory.hex_ident;

  return (
    <li className="rounded border border-slate-700 bg-slate-800/50 px-2 py-1.5">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="accent-blue-500"
          aria-label={`Select ${label}`}
        />
        <span className="text-sm text-slate-200 font-mono">{label}</span>
        <span className="text-xs text-slate-500">{trajectory.category}</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${style.dot}`} />
          {style.label}
        </span>
      </label>

      <div className="mt-1 text-xs text-slate-500">
        {summary.waypointCount} wp · {formatClock(summary.durationS)} ·{" "}
        {Math.round(summary.minAltFt)}–{Math.round(summary.maxAltFt)} ft ·{" "}
        {/* Only worth saying when there is more than one — a plain route is
            just a route, and "1 leg" is noise on every single-leg result. */}
        {summary.legCount > 1 && <>{summary.legCount} legs · </>}
        {summary.phases.join(", ")}
      </div>

      <div className="mt-1 flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={Math.max(duration, 1)}
          step={1}
          value={elapsed}
          onChange={(e) => onSeek(trajectory.hex_ident, Number(e.target.value))}
          aria-label={`${label} timeline`}
          className="flex-1 accent-blue-500 h-1"
        />
        <span className="text-xs text-slate-500 font-mono tabular-nums">
          {formatClock(elapsed)}/{formatClock(duration)}
        </span>
      </div>

      {scenario && (
        <div className="mt-1 flex items-center gap-2">
          {savedTrackId ? (
            <>
              {/* Saved: the offset is what places this aircraft in the
                  scenario's timeline, so it is editable right here. */}
              <label className="flex items-center gap-1 text-xs text-slate-500">
                Enters at
                <input
                  type="number"
                  min={0}
                  step={5}
                  value={scenario.offsetsByHex[trajectory.hex_ident] ?? 0}
                  onChange={(e) =>
                    scenario.onOffsetChange(savedTrackId, Number(e.target.value) || 0)
                  }
                  aria-label={`${label} start offset seconds`}
                  className="w-16 px-1 py-0.5 bg-slate-700 border border-slate-600 rounded text-xs text-slate-200 focus:border-blue-500 focus:outline-none"
                />
                s
              </label>
              <button
                type="button"
                onClick={() => scenario.onRemoveFromScenario(savedTrackId)}
                aria-label={`Remove ${label} from scenario`}
                className="ml-auto px-1.5 py-0.5 text-xs text-slate-500 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors"
              >
                Remove
              </button>
            </>
          ) : (
            <>
              <span className="text-xs text-amber-500/80">unsaved</span>
              <button
                type="button"
                onClick={() => scenario.onAddToScenario(trajectory, generatedRequest)}
                disabled={scenario.activeScenarioId === null}
                title={
                  scenario.activeScenarioId === null
                    ? "Select or create a scenario first"
                    : undefined
                }
                aria-label={`Add ${label} to scenario`}
                className="ml-auto px-1.5 py-0.5 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-900/20 disabled:text-slate-600 disabled:hover:bg-transparent rounded transition-colors"
              >
                + Add to scenario
              </button>
            </>
          )}
        </div>
      )}

      <div className="sr-only" aria-live="polite">
        {label} {style.label} at {Math.round(progressOf(entry, trajectory) * 100)} percent
      </div>
    </li>
  );
}

"use client";
/**
 * Scenario selector and master transport for the Simulation Agent panel.
 *
 * A scenario is a named, persisted collection of timed tracks. This bar picks
 * one, manages the collection (new / rename / delete), and drives the master
 * clock that plays every track together with its own start offset — which is
 * what makes a scenario a scenario rather than a bag of trajectories.
 *
 * Per-track transport in `SimulationPanel` keeps working: the master clock only
 * takes over while it is running (see `mergeScenarioPlayback`).
 */
import { useCallback, useState } from "react";
import { formatClock } from "@/lib/trajectory-playback";
import type { ScenarioClock } from "@/lib/scenario-playback";
import type { Scenario, ScenarioTrack } from "@/lib/types";
import { ScenarioDescription } from "./ScenarioDescription";

export interface ScenarioBarProps {
  scenarios: Scenario[];
  activeScenarioId: string | null;
  /** True when DuckDB is unavailable — scenarios cannot be saved at all. */
  storageUnavailable: boolean;
  /** The active scenario's tracks — the material the AI description is drafted from. */
  tracks: ScenarioTrack[];
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onSaveDescription: (id: string, description: string) => Promise<void> | void;
  onDelete: (id: string) => void;
  clock: ScenarioClock;
  durationS: number;
  onStart: () => void;
  onPause: () => void;
  onStop: () => void;
  onSeek: (elapsedS: number) => void;
}

export function ScenarioBar({
  scenarios,
  activeScenarioId,
  storageUnavailable,
  tracks,
  onSelect,
  onCreate,
  onRename,
  onSaveDescription,
  onDelete,
  clock,
  durationS,
  onStart,
  onPause,
  onStop,
  onSeek,
}: ScenarioBarProps) {
  // `null` = not editing. Kept as its own state so the input can be emptied
  // while typing without the name snapping back.
  const [draftName, setDraftName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const active = scenarios.find((s) => s.id === activeScenarioId) ?? null;

  const submitDraft = useCallback(() => {
    const name = (draftName ?? "").trim();
    if (name === "") {
      setDraftName(null);
      setCreating(false);
      return;
    }
    if (creating) onCreate(name);
    else if (active) onRename(active.id, name);
    setDraftName(null);
    setCreating(false);
  }, [draftName, creating, active, onCreate, onRename]);

  if (storageUnavailable) {
    return (
      <div className="text-xs text-amber-400" data-testid="scenario-unavailable">
        Scenarios need the local database, which is unavailable. Generated
        trajectories still work, but cannot be saved.
      </div>
    );
  }

  const editing = draftName !== null;

  return (
    <div className="flex flex-col gap-2" data-testid="scenario-bar">
      {editing ? (
        <div className="flex gap-1.5">
          <input
            type="text"
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitDraft();
              if (e.key === "Escape") {
                setDraftName(null);
                setCreating(false);
              }
            }}
            placeholder="Scenario name"
            aria-label={creating ? "New scenario name" : "Rename scenario"}
            className="flex-1 px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={submitDraft}
            className="px-2 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white transition-colors"
          >
            Save
          </button>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <select
            value={activeScenarioId ?? ""}
            onChange={(e) => onSelect(e.target.value === "" ? null : e.target.value)}
            aria-label="Active scenario"
            className="flex-1 min-w-0 px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 focus:border-blue-500 focus:outline-none"
          >
            <option value="">No scenario</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.track_count})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setDraftName("");
            }}
            title="New scenario"
            aria-label="New scenario"
            className="px-2 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs text-slate-200 transition-colors"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setDraftName(active?.name ?? "")}
            disabled={!active}
            title="Rename scenario"
            aria-label="Rename scenario"
            className="px-2 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 rounded text-xs text-slate-200 transition-colors"
          >
            ✎
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            disabled={!active}
            title="Delete scenario"
            aria-label="Delete scenario"
            className="px-2 py-1.5 bg-slate-700 hover:bg-red-900/40 hover:text-red-400 disabled:bg-slate-800 disabled:text-slate-600 rounded text-xs text-slate-200 transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      {/* Deleting a scenario destroys every track in it, so it asks first. */}
      {confirmingDelete && active && (
        <div
          role="alertdialog"
          aria-label="Confirm delete scenario"
          className="flex items-center gap-2 rounded border border-red-900 bg-red-950/40 px-2 py-1.5"
        >
          <span className="text-xs text-red-300 flex-1">
            Delete “{active.name}” and its {active.track_count} track
            {active.track_count === 1 ? "" : "s"}?
          </span>
          <button
            type="button"
            onClick={() => {
              onDelete(active.id);
              setConfirmingDelete(false);
            }}
            className="px-2 py-1 bg-red-700 hover:bg-red-600 rounded text-xs text-white transition-colors"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(false)}
            className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs text-slate-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Hidden while renaming or confirming a delete: those flows own the
          panel, and stacking a second editor under them is just noise. */}
      {active && !editing && !confirmingDelete && (
        <ScenarioDescription
          scenarioId={active.id}
          scenarioName={active.name}
          description={active.description}
          tracks={tracks}
          onSave={onSaveDescription}
        />
      )}

      {active && (
        <div className="flex flex-col gap-1.5" data-testid="scenario-transport">
          <div className="flex items-center gap-1.5">
            {clock.state === "playing" ? (
              <button
                type="button"
                onClick={onPause}
                className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs text-slate-200 transition-colors"
              >
                Pause
              </button>
            ) : (
              <button
                type="button"
                onClick={onStart}
                disabled={durationS === 0}
                className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-600 rounded text-xs text-white transition-colors"
              >
                {clock.state === "paused" ? "Resume" : "Play scenario"}
              </button>
            )}
            <button
              type="button"
              onClick={onStop}
              disabled={clock.state === "stopped"}
              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 rounded text-xs text-slate-200 transition-colors"
            >
              Stop
            </button>
            <span className="ml-auto text-xs text-slate-500 font-mono tabular-nums">
              {formatClock(clock.elapsedS)}/{formatClock(durationS)}
            </span>
          </div>

          <input
            type="range"
            min={0}
            max={Math.max(durationS, 1)}
            step={1}
            value={clock.elapsedS}
            onChange={(e) => onSeek(Number(e.target.value))}
            aria-label="Scenario timeline"
            className="w-full accent-emerald-500 h-1"
          />
        </div>
      )}
    </div>
  );
}

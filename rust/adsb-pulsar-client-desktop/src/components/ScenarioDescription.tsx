"use client";
/**
 * Description editor for the active scenario.
 *
 * A scenario is otherwise identified only by a name and a track count, which
 * tells you nothing a week later. The description is what makes it legible.
 *
 * Two ways to write one, both ending at the same Save button:
 *  - type it, or
 *  - press "Generate from trajectories" and let the agent draft it from the
 *    scenario's actual track data.
 *
 * Generated text lands in the textarea as an *unsaved draft*. The model never
 * writes to the database on its own — the user reads it, edits it, and saves.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trackDigest } from "@/lib/scenario-convert";
import { describeScenario } from "@/lib/scenario-describe-api";
import type { ScenarioTrack } from "@/lib/types";

export interface ScenarioDescriptionProps {
  scenarioId: string;
  scenarioName: string;
  /** The description as stored. `""` when the scenario has none. */
  description: string;
  tracks: ScenarioTrack[];
  onSave: (id: string, description: string) => Promise<void> | void;
}

export function ScenarioDescription({
  scenarioId,
  scenarioName,
  description,
  tracks,
  onSave,
}: ScenarioDescriptionProps) {
  const [draft, setDraft] = useState(description);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adjust-state-during-render rather than an effect: this reconciles props
  // into local state without a second render pass, and without the
  // set-state-in-effect flicker.
  const [prev, setPrev] = useState({ scenarioId, description });
  if (prev.scenarioId !== scenarioId) {
    // A different scenario entirely — the old draft is meaningless.
    setPrev({ scenarioId, description });
    setDraft(description);
    setError(null);
  } else if (prev.description !== description) {
    setPrev({ scenarioId, description });
    // Adopt an externally saved description (e.g. written from chat), but only
    // when the user has nothing unsaved — never clobber what they are typing.
    if (draft === prev.description) setDraft(description);
  }

  const abortRef = useRef<AbortController | null>(null);

  // Cleanup keyed on scenarioId, so it fires on both scenario change and
  // unmount: a generation started for one scenario must never land on another.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [scenarioId]);

  const digests = useMemo(() => tracks.map(trackDigest), [tracks]);

  const dirty = draft !== description;
  const hasTracks = tracks.length > 0;

  const generate = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setError(null);
    setGenerating(true);
    try {
      const result = await describeScenario(scenarioName, digests, controller.signal);
      if (controller.signal.aborted) return;
      setDraft(result);
    } catch (e) {
      // An abort is the user's own doing (cancel, or switching scenario) —
      // reporting it as a failure would be noise.
      if ((e as { name?: string })?.name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!controller.signal.aborted) setGenerating(false);
    }
  }, [scenarioName, digests]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(scenarioId, draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [onSave, scenarioId, draft]);

  return (
    <div className="flex flex-col gap-1.5" data-testid="scenario-description">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        aria-label="Scenario description"
        placeholder="What happens in this scenario?"
        className="w-full px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-xs text-slate-200 placeholder-slate-500 focus:border-blue-500 focus:outline-none resize-y"
      />

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={generate}
          disabled={generating || !hasTracks}
          // Stable accessible name: only the visible label changes while
          // running, so assistive tech and tests keep one handle on the button.
          aria-label="Generate from trajectories"
          title={
            hasTracks
              ? "Ask the AI agent to draft a description from this scenario's trajectories. You can edit it before saving."
              : "Add tracks to the scenario first — there are no trajectories to describe."
          }
          className="px-2 py-1 bg-violet-700 hover:bg-violet-600 disabled:bg-slate-800 disabled:text-slate-600 rounded text-xs text-white transition-colors"
        >
          {generating ? "Generating…" : "✨ Generate from trajectories"}
        </button>

        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          // Qualified names: the bar has its own Save/Cancel for the scenario
          // name, and two controls both announced as "Save" is ambiguous to
          // assistive tech even when they are visually distinct.
          aria-label="Save description"
          className="ml-auto px-2 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-600 rounded text-xs text-white transition-colors"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(description);
            setError(null);
          }}
          disabled={!dirty}
          aria-label="Discard description changes"
          className="px-2 py-1 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 rounded text-xs text-slate-200 transition-colors"
        >
          Cancel
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded border border-red-900 bg-red-950/40 px-2 py-1 text-xs text-red-300"
        >
          {error}
        </div>
      )}
    </div>
  );
}

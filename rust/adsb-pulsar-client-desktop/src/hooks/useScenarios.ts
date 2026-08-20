"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createScenario as createScenarioCommand,
  createScenarioTrack,
  deleteScenario as deleteScenarioCommand,
  deleteScenarioTrack,
  getScenario,
  listScenarios,
  updateScenario as updateScenarioCommand,
  updateScenarioTrack,
} from "@/lib/commands";
import { scenarioTracksToTrajectories, trajectoryToCreateTrack, uniqueHexIdent } from "@/lib/scenario-convert";
import type { AgentTrajectory } from "@/lib/simulation-data";
import type { CreateScenario, Scenario, ScenarioTrack } from "@/lib/types";
import { useLocalStorage } from "./useLocalStorage";

/** Storage rejects with this exact string when DuckDB is unavailable. */
const STORAGE_UNAVAILABLE = "Storage not available";

function isStorageUnavailable(e: unknown): boolean {
  return String(e).includes(STORAGE_UNAVAILABLE);
}

export interface ScenariosApi {
  scenarios: Scenario[];
  activeScenarioId: string | null;
  activeScenario: Scenario | null;
  tracks: ScenarioTrack[];
  /** The active scenario's tracks as playable trajectories. */
  tracksAsTrajectories: AgentTrajectory[];
  loading: boolean;
  error: string | null;
  /** True when DuckDB is unavailable — the UI disables scenario controls. */
  storageUnavailable: boolean;
  selectScenario: (id: string | null) => void;
  createScenario: (scenario: CreateScenario) => Promise<Scenario>;
  renameScenario: (id: string, name: string) => Promise<void>;
  /**
   * Save a scenario's prose description. `""` deliberately clears it.
   *
   * Separate from `renameScenario` because storage COALESCEs omitted fields:
   * each setter sends only what it means to change, and leaves the rest alone.
   */
  setDescription: (id: string, description: string) => Promise<void>;
  removeScenario: (id: string) => Promise<void>;
  addTrajectory: (
    trajectory: AgentTrajectory,
    startOffsetS?: number,
    request?: unknown | null,
  ) => Promise<ScenarioTrack>;
  removeTrack: (trackId: string) => Promise<void>;
  setTrackOffset: (trackId: string, startOffsetS: number) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Owns the scenario list, the active scenario and its tracks, and all CRUD.
 *
 * Degrades gracefully when storage is unavailable: rather than surfacing an
 * error boundary, `storageUnavailable` goes true and the lists stay empty, so
 * the app runs real-time-only exactly as the DB history panel does.
 *
 * The active scenario id is persisted so the app reopens where it was left.
 */
export function useScenarios(): ScenariosApi {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [activeScenarioId, setActiveScenarioId] = useLocalStorage<string | null>(
    "adsb-active-scenario-id",
    null,
  );
  const [tracks, setTracks] = useState<ScenarioTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState(false);

  const fetchScenarios = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await listScenarios();
      setScenarios(result);
      setStorageUnavailable(false);
    } catch (e) {
      if (isStorageUnavailable(e)) {
        setScenarios([]);
        setStorageUnavailable(true);
      } else {
        setError(String(e));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchTracks = useCallback(async (id: string | null) => {
    if (id === null) {
      setTracks([]);
      return;
    }
    try {
      const result = await getScenario(id);
      setTracks(result.tracks);
    } catch (e) {
      // A stale active id (its scenario was deleted elsewhere) must not wedge
      // the panel — drop the tracks and let the picker fall back.
      setTracks([]);
      if (!isStorageUnavailable(e)) setError(String(e));
    }
  }, []);

  useEffect(() => {
    void fetchScenarios();
  }, [fetchScenarios]);

  useEffect(() => {
    void fetchTracks(activeScenarioId);
  }, [fetchTracks, activeScenarioId]);

  const refresh = useCallback(async () => {
    await fetchScenarios();
    await fetchTracks(activeScenarioId);
  }, [fetchScenarios, fetchTracks, activeScenarioId]);

  const selectScenario = useCallback(
    (id: string | null) => {
      setActiveScenarioId(id);
    },
    [setActiveScenarioId],
  );

  const createScenario = useCallback(
    async (scenario: CreateScenario): Promise<Scenario> => {
      const created = await createScenarioCommand(scenario);
      await fetchScenarios();
      // A newly created scenario becomes the active one: the user made it in
      // order to put something in it.
      setActiveScenarioId(created.id);
      return created;
    },
    [fetchScenarios, setActiveScenarioId],
  );

  const renameScenario = useCallback(
    async (id: string, name: string): Promise<void> => {
      await updateScenarioCommand({ id, name });
      await fetchScenarios();
    },
    [fetchScenarios],
  );

  const setDescription = useCallback(
    async (id: string, description: string): Promise<void> => {
      // `name` is required by UpdateScenario, so send the current one — an
      // empty name would blank the scenario's title. Everything else is
      // omitted and COALESCEd to its stored value.
      const name = scenarios.find((s) => s.id === id)?.name ?? "";
      await updateScenarioCommand({ id, name, description });
      await fetchScenarios();
    },
    [fetchScenarios, scenarios],
  );

  const removeScenario = useCallback(
    async (id: string): Promise<void> => {
      await deleteScenarioCommand(id);
      if (id === activeScenarioId) setActiveScenarioId(null);
      await fetchScenarios();
    },
    [fetchScenarios, activeScenarioId, setActiveScenarioId],
  );

  const addTrajectory = useCallback(
    async (
      trajectory: AgentTrajectory,
      startOffsetS = 0,
      request: unknown | null = null,
    ): Promise<ScenarioTrack> => {
      if (activeScenarioId === null) {
        throw new Error("No scenario selected");
      }

      // Playback is keyed by hex_ident, so a duplicate would make two aircraft
      // share one clock and silently hide one of them.
      const hex = uniqueHexIdent(
        tracks.map((t) => t.hex_ident),
        trajectory.hex_ident,
      );

      const created = await createScenarioTrack(
        trajectoryToCreateTrack(
          { ...trajectory, hex_ident: hex },
          activeScenarioId,
          startOffsetS,
          request,
        ),
      );
      await fetchTracks(activeScenarioId);
      await fetchScenarios();
      return created;
    },
    [activeScenarioId, tracks, fetchTracks, fetchScenarios],
  );

  const removeTrack = useCallback(
    async (trackId: string): Promise<void> => {
      await deleteScenarioTrack(trackId);
      await fetchTracks(activeScenarioId);
      await fetchScenarios();
    },
    [activeScenarioId, fetchTracks, fetchScenarios],
  );

  const setTrackOffset = useCallback(
    async (trackId: string, startOffsetS: number): Promise<void> => {
      await updateScenarioTrack({ id: trackId, start_offset_s: startOffsetS });
      await fetchTracks(activeScenarioId);
    },
    [activeScenarioId, fetchTracks],
  );

  const activeScenario = useMemo(
    () => scenarios.find((s) => s.id === activeScenarioId) ?? null,
    [scenarios, activeScenarioId],
  );

  const tracksAsTrajectories = useMemo(() => scenarioTracksToTrajectories(tracks), [tracks]);

  return {
    scenarios,
    activeScenarioId,
    activeScenario,
    tracks,
    tracksAsTrajectories,
    loading,
    error,
    storageUnavailable,
    selectScenario,
    createScenario,
    renameScenario,
    setDescription,
    removeScenario,
    addTrajectory,
    removeTrack,
    setTrackOffset,
    refresh,
  };
}

"use client";
import { useState, useEffect, useCallback } from "react";
import { useTauriEvent } from "./useTauriEvent";
import { getRecordingState, setRecordingState } from "@/lib/commands";
import type { RecordingState } from "@/lib/types";

const INITIAL_STATE: RecordingState = {
  record_positions: true,
  record_raw: true,
};

/**
 * Manages recording state (which DuckDB streams are active).
 * Fetches initial state on mount and listens for backend events.
 */
export function useRecordingState() {
  const [state, setState] = useState<RecordingState>(INITIAL_STATE);

  // Hydrate from backend on mount
  useEffect(() => {
    getRecordingState().then(setState).catch(() => {});
  }, []);

  // Listen for backend events (e.g. from another window or command)
  useTauriEvent<RecordingState>("adsb:recording-state", setState);

  const toggleRecordPositions = useCallback(() => {
    const next = { ...state, record_positions: !state.record_positions };
    setState(next);
    setRecordingState(next).catch(() => {});
  }, [state]);

  const toggleRecordRaw = useCallback(() => {
    const next = { ...state, record_raw: !state.record_raw };
    setState(next);
    setRecordingState(next).catch(() => {});
  }, [state]);

  return {
    recordPositions: state.record_positions,
    recordRaw: state.record_raw,
    toggleRecordPositions,
    toggleRecordRaw,
  };
}

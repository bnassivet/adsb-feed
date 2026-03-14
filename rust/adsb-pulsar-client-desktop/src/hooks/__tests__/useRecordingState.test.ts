import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  mockInvokeResponse,
  clearMockResponses,
  emitMockEvent,
} from "@/test/mocks/tauri";
import { useRecordingState } from "../useRecordingState";

describe("useRecordingState", () => {
  beforeEach(() => {
    clearMockResponses();
  });

  it("defaults to both recording ON", () => {
    mockInvokeResponse("get_recording_state", {
      record_positions: true,
      record_raw: true,
    });

    const { result } = renderHook(() => useRecordingState());
    expect(result.current.recordPositions).toBe(true);
    expect(result.current.recordRaw).toBe(true);
  });

  it("fetches initial state from backend on mount", async () => {
    mockInvokeResponse("get_recording_state", {
      record_positions: false,
      record_raw: true,
    });

    const { result } = renderHook(() => useRecordingState());

    await waitFor(() => {
      expect(result.current.recordPositions).toBe(false);
    });
    expect(result.current.recordRaw).toBe(true);
  });

  it("toggleRecordPositions calls backend with flipped value", async () => {
    mockInvokeResponse("get_recording_state", {
      record_positions: true,
      record_raw: true,
    });
    // Mock set command — will be called when toggling
    mockInvokeResponse("set_recording_state", undefined);

    const { result } = renderHook(() => useRecordingState());

    await waitFor(() => {
      expect(result.current.recordPositions).toBe(true);
    });

    act(() => {
      result.current.toggleRecordPositions();
    });

    expect(result.current.recordPositions).toBe(false);
    expect(result.current.recordRaw).toBe(true);
  });

  it("toggleRecordRaw calls backend with flipped value", async () => {
    mockInvokeResponse("get_recording_state", {
      record_positions: true,
      record_raw: true,
    });
    mockInvokeResponse("set_recording_state", undefined);

    const { result } = renderHook(() => useRecordingState());

    await waitFor(() => {
      expect(result.current.recordRaw).toBe(true);
    });

    act(() => {
      result.current.toggleRecordRaw();
    });

    expect(result.current.recordRaw).toBe(false);
    expect(result.current.recordPositions).toBe(true);
  });

  it("updates state when backend event is received", async () => {
    mockInvokeResponse("get_recording_state", {
      record_positions: true,
      record_raw: true,
    });

    const { result } = renderHook(() => useRecordingState());

    await waitFor(() => {
      expect(result.current.recordPositions).toBe(true);
    });

    act(() => {
      emitMockEvent("adsb:recording-state", {
        record_positions: false,
        record_raw: false,
      });
    });

    expect(result.current.recordPositions).toBe(false);
    expect(result.current.recordRaw).toBe(false);
  });
});

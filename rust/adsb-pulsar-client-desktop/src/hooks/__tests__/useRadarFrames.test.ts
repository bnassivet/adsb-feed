import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import { useRadarFrames, useFrameAnimation } from "../useRadarFrames";
import { getRadarFrames } from "@/lib/commands";
import { ANIMATION_FRAME_MS, ANIMATION_HOLD_MS, type RadarFrames } from "@/lib/radar";

const strict = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);
const HERE = { lat: 47, lng: -1.5 };
const T = Date.UTC(2026, 10, 19, 3, 0);
const min = (m: number) => T + m * 60_000;

type Args = { lat: number; lng: number; radiusNm: number; knownMs: number[] };

describe("getRadarFrames", () => {
  beforeEach(() => clearMockResponses());

  it("passes position, radius and the frames already held", async () => {
    let args: unknown;
    mockInvokeResponse("get_radar_frames", (a: unknown) => {
      args = a;
      return { bounds: [0, 0, 1, 1], frames: [] };
    });
    await getRadarFrames(47, -1.5, 300, [1, 2]);
    expect(args).toEqual({ lat: 47, lng: -1.5, radiusNm: 300, knownMs: [1, 2] });
  });
});

describe("useRadarFrames", () => {
  let calls: Args[] = [];
  const respond = (fn: (a: Args) => RadarFrames | Promise<never>) =>
    mockInvokeResponse("get_radar_frames", (a: Args) => {
      calls.push(a);
      return fn(a);
    });
  const all = (times: number[]) => (a: Args): RadarFrames => ({
    bounds: [42, -9, 52, 6],
    frames: times.map((t) => ({ validTimeMs: t, pngBase64: a.knownMs.includes(t) ? null : `i${t}` })),
  });

  beforeEach(() => {
    clearMockResponses();
    calls = [];
  });

  it("does nothing while off", () => {
    respond(all([min(0)]));
    const { result } = renderHook(() => useRadarFrames(false, HERE, min(0)));
    expect(result.current.frames).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("loads once when switched on, under StrictMode too", async () => {
    respond(all([min(0), min(5)]));
    const { result } = renderHook(() => useRadarFrames(true, HERE, min(5)), { wrapper: strict });
    await waitFor(() => expect(result.current.frames?.frames).toHaveLength(2));
    expect(calls).toHaveLength(1);
    expect(calls[0].knownMs).toEqual([]);
  });

  it("asks again for each new image, saying which frames it holds", async () => {
    let times = [min(0), min(5)];
    respond((a) => all(times)(a));
    const { result, rerender } = renderHook(({ latest }) => useRadarFrames(true, HERE, latest), {
      initialProps: { latest: min(5) },
    });
    await waitFor(() => expect(result.current.frames?.frames).toHaveLength(2));
    times = [min(0), min(5), min(10)];
    rerender({ latest: min(10) });
    await waitFor(() => expect(result.current.frames?.frames).toHaveLength(3));
    expect(calls[1].knownMs).toEqual([min(0), min(5)]);
    expect(result.current.frames?.frames[0].url).toBe(`data:image/png;base64,i${min(0)}`);
  });

  it("forgets the frames it holds when the receiver moves", async () => {
    respond(all([min(0)]));
    const { result, rerender } = renderHook(({ c }) => useRadarFrames(true, c, min(0)), { initialProps: { c: HERE } });
    await waitFor(() => expect(result.current.frames?.frames).toHaveLength(1));
    rerender({ c: { lat: 48, lng: -1.5 } });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].knownMs).toEqual([]);
  });

  it("reports a failed command", async () => {
    respond(() => Promise.reject("No app data directory"));
    const { result } = renderHook(() => useRadarFrames(true, HERE, min(0)));
    await waitFor(() => expect(result.current.error).toBe("No app data directory"));
  });
});

describe("useFrameAnimation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the newest frame while not playing", () => {
    const { result } = renderHook(() => useFrameAnimation(5, false));
    expect(result.current).toBe(4);
  });

  it("steps, holds on the newest, then loops", () => {
    const { result } = renderHook(() => useFrameAnimation(3, true));
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(ANIMATION_FRAME_MS));
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(ANIMATION_FRAME_MS));
    expect(result.current).toBe(2);
    act(() => vi.advanceTimersByTime(ANIMATION_HOLD_MS - 1));
    expect(result.current).toBe(2);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(0);
  });

  it("does not run with fewer than two frames", () => {
    const { result } = renderHook(() => useFrameAnimation(1, true));
    act(() => vi.advanceTimersByTime(ANIMATION_HOLD_MS * 3));
    expect(result.current).toBe(0);
  });

  it("stays in range when frames drop out", () => {
    const { result, rerender } = renderHook(({ n }) => useFrameAnimation(n, true), { initialProps: { n: 5 } });
    for (let i = 0; i < 4; i++) act(() => vi.advanceTimersByTime(ANIMATION_FRAME_MS));
    expect(result.current).toBe(4);
    rerender({ n: 3 });
    expect(result.current).toBeLessThan(3);
  });
});

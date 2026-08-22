import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  PLAYBACK_TICK_MS,
  useTrajectoryPlayback,
} from "@/hooks/useTrajectoryPlayback";
import type { AgentTrajectory, DynamicWaypoint } from "@/lib/simulation-data";

/** The state machine is covered in `lib/__tests__/trajectory-playback.test.ts`;
 *  this covers the React wiring — reconciliation, the clock, and the controls. */

function wp(t: number): DynamicWaypoint {
  return {
    lat: 45.5,
    lng: -73.6,
    alt_ft: 1000,
    speed_kts: 100,
    heading_deg: 0,
    phase: "cruise",
    t_offset_s: t,
  };
}

function traj(id: string, duration = 100): AgentTrajectory {
  return {
    hex_ident: id,
    callsign: id,
    category: "helicopter",
    waypoints: [wp(0), wp(duration)],
  };
}

const A = traj("SIM-A", 100);
const B = traj("SIM-B", 60);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useTrajectoryPlayback — reconciliation", () => {
  it("starts empty", () => {
    const { result } = renderHook(() => useTrajectoryPlayback([]));
    expect(result.current.playback).toEqual({});
  });

  it("registers new trajectories as stopped", () => {
    /* Nothing moves until the user presses Start. */
    const { result } = renderHook(() => useTrajectoryPlayback([A, B]));
    expect(result.current.playback["SIM-A"]).toEqual({ state: "stopped", elapsedS: 0 });
    expect(result.current.playback["SIM-B"]).toEqual({ state: "stopped", elapsedS: 0 });
  });

  it("drops trajectories that are removed", () => {
    const { result, rerender } = renderHook(({ t }) => useTrajectoryPlayback(t), {
      initialProps: { t: [A, B] },
    });
    rerender({ t: [A] });
    expect(result.current.playback["SIM-B"]).toBeUndefined();
  });

  it("keeps state across an identical-but-new array", () => {
    /* A parent re-render must not reset playback. */
    const { result, rerender } = renderHook(({ t }) => useTrajectoryPlayback(t), {
      initialProps: { t: [A] },
    });
    act(() => result.current.start(["SIM-A"]));
    rerender({ t: [{ ...A }] });
    expect(result.current.playback["SIM-A"].state).toBe("playing");
  });

  it("does not loop forever on an inline array", () => {
    /* Regression: keying the effect on array identity spun the renderer. */
    const { result } = renderHook(() => useTrajectoryPlayback([traj("SIM-X")]));
    expect(result.current.playback["SIM-X"]).toBeDefined();
  });
});

describe("useTrajectoryPlayback — clock", () => {
  it("advances a playing trajectory", () => {
    const { result } = renderHook(() => useTrajectoryPlayback([A]));
    act(() => result.current.start(["SIM-A"]));
    act(() => vi.advanceTimersByTime(PLAYBACK_TICK_MS * 4));
    expect(result.current.playback["SIM-A"].elapsedS).toBeCloseTo(2);
  });

  it("does not advance a stopped trajectory", () => {
    const { result } = renderHook(() => useTrajectoryPlayback([A]));
    act(() => vi.advanceTimersByTime(PLAYBACK_TICK_MS * 10));
    expect(result.current.playback["SIM-A"].elapsedS).toBe(0);
  });

  it("does not advance a paused trajectory", () => {
    const { result } = renderHook(() => useTrajectoryPlayback([A]));
    act(() => result.current.start(["SIM-A"]));
    act(() => vi.advanceTimersByTime(PLAYBACK_TICK_MS * 4));
    act(() => result.current.pause(["SIM-A"]));
    const frozen = result.current.playback["SIM-A"].elapsedS;
    act(() => vi.advanceTimersByTime(PLAYBACK_TICK_MS * 10));
    expect(result.current.playback["SIM-A"].elapsedS).toBe(frozen);
  });

  it("pauses at the end of the route", () => {
    const short = traj("SIM-S", 1);
    const { result } = renderHook(() => useTrajectoryPlayback([short]));
    act(() => result.current.start(["SIM-S"]));
    act(() => vi.advanceTimersByTime(PLAYBACK_TICK_MS * 10));
    expect(result.current.playback["SIM-S"]).toEqual({ state: "paused", elapsedS: 1 });
  });

  it("runs each trajectory on its own clock", () => {
    const { result } = renderHook(() => useTrajectoryPlayback([A, B]));
    act(() => result.current.start(["SIM-A"]));
    act(() => vi.advanceTimersByTime(PLAYBACK_TICK_MS * 4));
    expect(result.current.playback["SIM-A"].elapsedS).toBeGreaterThan(0);
    expect(result.current.playback["SIM-B"].elapsedS).toBe(0);
  });
});

describe("useTrajectoryPlayback — controls", () => {
  it("start begins playback", () => {
    const { result } = renderHook(() => useTrajectoryPlayback([A]));
    act(() => result.current.start(["SIM-A"]));
    expect(result.current.playback["SIM-A"]).toEqual({ state: "playing", elapsedS: 0 });
  });

  it("resume continues from the paused position", () => {
    const { result } = renderHook(() => useTrajectoryPlayback([A]));
    act(() => result.current.start(["SIM-A"]));
    act(() => vi.advanceTimersByTime(PLAYBACK_TICK_MS * 6));
    act(() => result.current.pause(["SIM-A"]));
    const at = result.current.playback["SIM-A"].elapsedS;

    act(() => result.current.resume(["SIM-A"]));
    expect(result.current.playback["SIM-A"]).toEqual({ state: "playing", elapsedS: at });
  });

  it("stop rewinds to the beginning", () => {
    const { result } = renderHook(() => useTrajectoryPlayback([A]));
    act(() => result.current.start(["SIM-A"]));
    act(() => vi.advanceTimersByTime(PLAYBACK_TICK_MS * 6));
    act(() => result.current.stop(["SIM-A"]));
    expect(result.current.playback["SIM-A"]).toEqual({ state: "stopped", elapsedS: 0 });
  });

  it("controls act on several trajectories at once", () => {
    const { result } = renderHook(() => useTrajectoryPlayback([A, B]));
    act(() => result.current.start(["SIM-A", "SIM-B"]));
    expect(result.current.playback["SIM-A"].state).toBe("playing");
    expect(result.current.playback["SIM-B"].state).toBe("playing");
  });

  it("seek jumps within the route", () => {
    const { result } = renderHook(() => useTrajectoryPlayback([A]));
    act(() => result.current.start(["SIM-A"]));
    act(() => result.current.seek("SIM-A", 42));
    expect(result.current.playback["SIM-A"].elapsedS).toBe(42);
  });

  it("seek clamps to the trajectory's duration", () => {
    const { result } = renderHook(() => useTrajectoryPlayback([B]));
    act(() => result.current.start(["SIM-B"]));
    act(() => result.current.seek("SIM-B", 9999));
    expect(result.current.playback["SIM-B"].elapsedS).toBe(60);
  });

  it("seek uses the current trajectory list, not a stale one", () => {
    /* The seek callback is stable across renders, so it must read the latest
       trajectories rather than the ones captured when it was created. */
    const { result, rerender } = renderHook(({ t }) => useTrajectoryPlayback(t), {
      initialProps: { t: [A] },
    });
    rerender({ t: [A, B] });
    act(() => result.current.seek("SIM-B", 9999));
    expect(result.current.playback["SIM-B"].elapsedS).toBe(60);
  });

  it("playback continues after the clock keeps ticking post-seek", () => {
    const { result } = renderHook(() => useTrajectoryPlayback([A]));
    act(() => result.current.start(["SIM-A"]));
    act(() => result.current.seek("SIM-A", 10));
    act(() => vi.advanceTimersByTime(PLAYBACK_TICK_MS * 4));
    expect(result.current.playback["SIM-A"].elapsedS).toBeCloseTo(12);
  });
});

describe("useTrajectoryPlayback — auto-start on adoption", () => {
  /**
   * The chat path wants "simulate a helicopter" to show it flying, but
   * playback entries only exist after the sync effect runs — so calling
   * start() right after handing over trajectories would find nothing.
   * The panel path deliberately does NOT use this: it requires an explicit Start.
   */

  it("starts trajectories marked before they are adopted", () => {
    const { result, rerender } = renderHook(({ t }) => useTrajectoryPlayback(t), {
      initialProps: { t: [] as AgentTrajectory[] },
    });
    act(() => result.current.requestAutoStart(["SIM-A"]));
    rerender({ t: [A] });
    expect(result.current.playback["SIM-A"].state).toBe("playing");
  });

  it("leaves unmarked trajectories stopped", () => {
    const { result, rerender } = renderHook(({ t }) => useTrajectoryPlayback(t), {
      initialProps: { t: [] as AgentTrajectory[] },
    });
    act(() => result.current.requestAutoStart(["SIM-A"]));
    rerender({ t: [A, B] });
    expect(result.current.playback["SIM-A"].state).toBe("playing");
    expect(result.current.playback["SIM-B"].state).toBe("stopped");
  });

  it("applies only once", () => {
    /* A later batch must not inherit the previous request. */
    const { result, rerender } = renderHook(({ t }) => useTrajectoryPlayback(t), {
      initialProps: { t: [] as AgentTrajectory[] },
    });
    act(() => result.current.requestAutoStart(["SIM-A"]));
    rerender({ t: [A] });
    rerender({ t: [A, B] });
    expect(result.current.playback["SIM-B"].state).toBe("stopped");
  });

  it("adopting without a request leaves everything stopped", () => {
    const { result, rerender } = renderHook(({ t }) => useTrajectoryPlayback(t), {
      initialProps: { t: [] as AgentTrajectory[] },
    });
    rerender({ t: [A] });
    expect(result.current.playback["SIM-A"].state).toBe("stopped");
  });

  it("survives StrictMode's double-invoked updater", () => {
    /* Regression: the auto-start set was read AND cleared inside the
       setPlayback updater. React double-invokes updaters in StrictMode (which
       Next.js enables by default) to surface impure ones: the first call
       consumed the set and returned "playing", the second saw an empty set and
       returned "stopped" — and React keeps the second result. Chat-generated
       aircraft therefore arrived frozen in the real app while every non-Strict
       test passed. */
    const { result, rerender } = renderHook(({ t }) => useTrajectoryPlayback(t), {
      initialProps: { t: [] as AgentTrajectory[] },
      wrapper: StrictMode,
    });
    act(() => result.current.requestAutoStart(["SIM-A"]));
    rerender({ t: [A] });
    expect(result.current.playback["SIM-A"].state).toBe("playing");
  });

  it("ignores ids that never arrive", () => {
    const { result, rerender } = renderHook(({ t }) => useTrajectoryPlayback(t), {
      initialProps: { t: [] as AgentTrajectory[] },
    });
    act(() => result.current.requestAutoStart(["SIM-NEVER"]));
    rerender({ t: [A] });
    expect(result.current.playback["SIM-A"].state).toBe("stopped");
  });
});

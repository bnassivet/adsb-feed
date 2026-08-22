import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScenarioPlayback } from "../useScenarioPlayback";
import { PLAYBACK_TICK_MS } from "../useTrajectoryPlayback";
import type { ScenarioTiming } from "@/lib/scenario-playback";
import type { AgentTrajectory, DynamicWaypoint } from "@/lib/simulation-data";

function waypoint(tOffsetS: number): DynamicWaypoint {
  return {
    lat: 45.5,
    lng: -73.6,
    alt_ft: 1000,
    speed_kts: 80,
    heading_deg: 90,
    phase: "cruise",
    t_offset_s: tOffsetS,
  };
}

function trajectory(hex: string, durationS: number): AgentTrajectory {
  return {
    hex_ident: hex,
    callsign: hex,
    category: "helicopter",
    waypoints: [waypoint(0), waypoint(durationS)],
  };
}

/** EARLY runs 0–60s; LATE enters at 90s and runs 30s → 120s scenario. */
const timings: ScenarioTiming[] = [
  { trajectory: trajectory("EARLY", 60), startOffsetS: 0 },
  { trajectory: trajectory("LATE", 30), startOffsetS: 90 },
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Every test renders under StrictMode on purpose. Next.js enables it by
 * default, and the last playback regression here only reproduced under the
 * double-invocation it forces — a hook-only non-Strict test passed throughout.
 */
function renderScenario(initial: ScenarioTiming[] = timings) {
  return renderHook((props: ScenarioTiming[]) => useScenarioPlayback(props), {
    wrapper: StrictMode,
    initialProps: initial,
  });
}

describe("useScenarioPlayback", () => {
  it("starts stopped at zero", () => {
    const { result } = renderScenario();
    expect(result.current.clock).toEqual({ state: "stopped", elapsedS: 0 });
  });

  it("reports the scenario duration for the scrubber", () => {
    const { result } = renderScenario();
    expect(result.current.durationS).toBe(120);
  });

  it("is zero-length with no tracks", () => {
    const { result } = renderScenario([]);
    expect(result.current.durationS).toBe(0);
  });

  it("plays when started", () => {
    const { result } = renderScenario();
    act(() => result.current.start());
    expect(result.current.clock.state).toBe("playing");
  });

  it("advances the clock on each tick", () => {
    const { result } = renderScenario();
    act(() => result.current.start());

    act(() => {
      vi.advanceTimersByTime(PLAYBACK_TICK_MS * 4);
    });

    expect(result.current.clock.elapsedS).toBeCloseTo(2);
  });

  // The StrictMode trap: a double-invoked updater that consumed a ref would
  // keep the second (empty) result and the clock would never move.
  it("still advances under StrictMode double-invocation", () => {
    const { result } = renderScenario();
    act(() => result.current.start());

    act(() => {
      vi.advanceTimersByTime(PLAYBACK_TICK_MS * 2);
    });

    expect(result.current.clock.state).toBe("playing");
    expect(result.current.clock.elapsedS).toBeGreaterThan(0);
  });

  it("does not advance while stopped", () => {
    const { result } = renderScenario();
    act(() => {
      vi.advanceTimersByTime(PLAYBACK_TICK_MS * 10);
    });
    expect(result.current.clock).toEqual({ state: "stopped", elapsedS: 0 });
  });

  it("does not advance while paused", () => {
    const { result } = renderScenario();
    act(() => result.current.start());
    act(() => {
      vi.advanceTimersByTime(PLAYBACK_TICK_MS * 2);
    });
    act(() => result.current.pause());
    const frozen = result.current.clock.elapsedS;

    act(() => {
      vi.advanceTimersByTime(PLAYBACK_TICK_MS * 10);
    });

    expect(result.current.clock.elapsedS).toBe(frozen);
  });

  it("resumes from where it was paused", () => {
    const { result } = renderScenario();
    act(() => result.current.start());
    act(() => {
      vi.advanceTimersByTime(PLAYBACK_TICK_MS * 4);
    });
    act(() => result.current.pause());
    act(() => result.current.start());

    expect(result.current.clock.state).toBe("playing");
    expect(result.current.clock.elapsedS).toBeCloseTo(2);
  });

  it("rewinds on stop", () => {
    const { result } = renderScenario();
    act(() => result.current.start());
    act(() => {
      vi.advanceTimersByTime(PLAYBACK_TICK_MS * 4);
    });
    act(() => result.current.stop());

    expect(result.current.clock).toEqual({ state: "stopped", elapsedS: 0 });
  });

  it("pauses at the end instead of running past it", () => {
    const { result } = renderScenario();
    act(() => result.current.start());
    act(() => result.current.seek(119.9));
    act(() => {
      vi.advanceTimersByTime(PLAYBACK_TICK_MS);
    });

    expect(result.current.clock).toEqual({ state: "paused", elapsedS: 120 });
  });

  it("seeks to a point in the timeline", () => {
    const { result } = renderScenario();
    act(() => result.current.start());
    act(() => result.current.seek(45));
    expect(result.current.clock.elapsedS).toBe(45);
  });

  it("seeking a stopped scenario pauses it there so the aircraft show", () => {
    const { result } = renderScenario();
    act(() => result.current.seek(45));
    expect(result.current.clock).toEqual({ state: "paused", elapsedS: 45 });
  });

  it("clamps a seek past the end", () => {
    const { result } = renderScenario();
    act(() => result.current.seek(9999));
    expect(result.current.clock.elapsedS).toBe(120);
  });

  it("resets a running clock when the scenario's tracks change", () => {
    // Otherwise the clock keeps running against a timeline that no longer
    // exists — e.g. after switching scenarios mid-playback.
    const { result, rerender } = renderScenario();
    act(() => result.current.start());
    act(() => {
      vi.advanceTimersByTime(PLAYBACK_TICK_MS * 4);
    });

    rerender([{ trajectory: trajectory("OTHER", 10), startOffsetS: 0 }]);

    expect(result.current.clock).toEqual({ state: "stopped", elapsedS: 0 });
  });

  it("resets when only a start offset changes", () => {
    const { result, rerender } = renderScenario();
    act(() => result.current.start());

    rerender([
      { trajectory: trajectory("EARLY", 60), startOffsetS: 0 },
      { trajectory: trajectory("LATE", 30), startOffsetS: 45 },
    ]);

    expect(result.current.clock.state).toBe("stopped");
    expect(result.current.durationS).toBe(75);
  });

  it("does not loop forever when given a fresh array each render", () => {
    // The array-identity trap: this hook calls setClock, so keying an effect on
    // array identity would re-trigger it endlessly.
    const { result, rerender } = renderScenario();
    act(() => result.current.start());

    rerender([
      { trajectory: trajectory("EARLY", 60), startOffsetS: 0 },
      { trajectory: trajectory("LATE", 30), startOffsetS: 90 },
    ]);

    // Same content, new array → the clock must survive.
    expect(result.current.clock.state).toBe("playing");
  });
});

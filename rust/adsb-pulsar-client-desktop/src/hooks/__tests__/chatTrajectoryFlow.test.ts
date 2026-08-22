import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCallback, useState } from "react";
import { useTrajectoryPlayback } from "@/hooks/useTrajectoryPlayback";
import type { AgentTrajectory, DynamicWaypoint } from "@/lib/simulation-data";

/**
 * The chat delivery path, wired exactly as `page.tsx` wires it.
 *
 * `applySimulatedTrajectory` hands aircraft to `applyChatTrajectories`, which
 * must both adopt them and start them playing — "simulate a helicopter" should
 * show it flying, with no further clicks. That wiring lives in the page
 * component, which has no tests of its own, so this reproduces it directly.
 */

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

function traj(id: string): AgentTrajectory {
  return { hex_ident: id, callsign: id, category: "helicopter", waypoints: [wp(0), wp(120)] };
}

/** Mirrors page.tsx: state + playback + the chat entry point. */
function usePageWiring() {
  const [agentTrajectories, setAgentTrajectories] = useState<AgentTrajectory[]>([]);
  const playback = useTrajectoryPlayback(agentTrajectories);
  const applyChatTrajectories = useCallback(
    (aircraft: AgentTrajectory[]) => {
      playback.requestAutoStart(aircraft.map((a) => a.hex_ident));
      setAgentTrajectories(aircraft);
    },
    [playback],
  );
  return { agentTrajectories, playback, applyChatTrajectories };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("chat trajectory delivery", () => {
  it("adopts the aircraft", () => {
    const { result } = renderHook(() => usePageWiring());
    act(() => result.current.applyChatTrajectories([traj("SIM-A")]));
    expect(result.current.agentTrajectories).toHaveLength(1);
  });

  it("starts them playing without a further click", () => {
    const { result } = renderHook(() => usePageWiring());
    act(() => result.current.applyChatTrajectories([traj("SIM-A")]));
    expect(result.current.playback.playback["SIM-A"].state).toBe("playing");
  });

  it("advances them on the clock", () => {
    const { result } = renderHook(() => usePageWiring());
    act(() => result.current.applyChatTrajectories([traj("SIM-A")]));
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.playback.playback["SIM-A"].elapsedS).toBeGreaterThan(0);
  });

  it("works under StrictMode", () => {
    /* Next.js enables StrictMode by default, which double-invokes renders,
       effects and state updaters — the auto-start hand-off has to survive it. */
    const { result } = renderHook(() => usePageWiring(), { wrapper: StrictMode });
    act(() => result.current.applyChatTrajectories([traj("SIM-A")]));
    expect(result.current.playback.playback["SIM-A"].state).toBe("playing");
  });

  it("starts a second batch too", () => {
    /* Each generation replaces the previous set; the new ids must auto-start
       rather than inheriting the earlier batch's request. */
    const { result } = renderHook(() => usePageWiring());
    act(() => result.current.applyChatTrajectories([traj("SIM-A")]));
    act(() => result.current.applyChatTrajectories([traj("SIM-B")]));
    expect(result.current.playback.playback["SIM-B"].state).toBe("playing");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SimulationPanel, type ScenarioIntegration } from "@/components/SimulationPanel";
import type { AgentTrajectory } from "@/lib/simulation-data";
import type { PlaybackMap } from "@/lib/trajectory-playback";

vi.mock("@/lib/simulate-api", () => ({ simulateTrajectory: vi.fn() }));

const RECEIVER = { lat: 45.5, lng: -73.6 };

function traj(id: string, callsign: string): AgentTrajectory {
  return {
    hex_ident: id,
    callsign,
    category: "helicopter",
    waypoints: [
      { lat: 45.5, lng: -73.6, alt_ft: 1200, speed_kts: 95, heading_deg: 0, phase: "loiter", t_offset_s: 0 },
      { lat: 45.6, lng: -73.7, alt_ft: 1400, speed_kts: 95, heading_deg: 90, phase: "loiter", t_offset_s: 120 },
    ],
  };
}

const SAVED = traj("SIM-SAVED", "HELI001");
const STAGED = traj("SIM-STAGED", "HELI002");

function setup(scenarioOver: Partial<ScenarioIntegration> = {}, trajectories = [SAVED, STAGED]) {
  const scenario: ScenarioIntegration = {
    bar: <div data-testid="fake-scenario-bar" />,
    savedTrackIds: { "SIM-SAVED": "track-1" },
    offsetsByHex: { "SIM-SAVED": 90 },
    activeScenarioId: "s1",
    onAddToScenario: vi.fn(),
    onRemoveFromScenario: vi.fn(),
    onOffsetChange: vi.fn(),
    ...scenarioOver,
  };

  render(
    <SimulationPanel
      receiverLocation={RECEIVER}
      trajectories={trajectories}
      playback={{} as PlaybackMap}
      onTrajectories={vi.fn()}
      onStart={vi.fn()}
      onPause={vi.fn()}
      onResume={vi.fn()}
      onStop={vi.fn()}
      onSeek={vi.fn()}
      showSimulation={false}
      onToggleSimulation={vi.fn()}
      simulationCount={0}
      scenario={scenario}
    />,
  );

  return scenario;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SimulationPanel scenario integration", () => {
  it("renders the scenario bar it is given", () => {
    setup();
    expect(screen.getByTestId("fake-scenario-bar")).toBeInTheDocument();
  });

  it("offers to add a staged trajectory to the scenario", async () => {
    const user = userEvent.setup();
    const scenario = setup();

    await user.click(screen.getByLabelText("Add HELI002 to scenario"));
    expect(scenario.onAddToScenario).toHaveBeenCalledWith(STAGED, null);
  });

  // The route hint is the best description of what an aircraft does, and it is
  // only knowable from the request that generated it — nothing in the resulting
  // waypoints recovers "orbit the port then land downtown".
  it("saves the generating request alongside the trajectory", async () => {
    const user = userEvent.setup();
    const { simulateTrajectory } = await import("@/lib/simulate-api");
    vi.mocked(simulateTrajectory).mockResolvedValue({
      aircraft: [STAGED],
      violations: [],
      summary: "1 aircraft",
    });

    const scenario = setup();

    await user.type(
      screen.getByLabelText(/route/i),
      "orbit the port then land downtown",
    );
    await user.click(screen.getByRole("button", { name: /^generate$/i }));
    await screen.findByLabelText("Add HELI002 to scenario");

    await user.click(screen.getByLabelText("Add HELI002 to scenario"));

    expect(scenario.onAddToScenario).toHaveBeenCalledWith(
      STAGED,
      expect.objectContaining({ routeHint: "orbit the port then land downtown" }),
    );
  });

  it("passes no request for a trajectory it did not generate", async () => {
    // Chat-generated aircraft arrive as props with no request in this panel.
    const user = userEvent.setup();
    const scenario = setup();

    await user.click(screen.getByLabelText("Add HELI002 to scenario"));
    expect(scenario.onAddToScenario).toHaveBeenCalledWith(STAGED, null);
  });

  it("marks a staged trajectory as unsaved", () => {
    setup();
    expect(screen.getByText("unsaved")).toBeInTheDocument();
  });

  it("does not offer to add a trajectory already saved in the scenario", () => {
    setup();
    expect(screen.queryByLabelText("Add HELI001 to scenario")).not.toBeInTheDocument();
  });

  it("cannot add anything when no scenario is selected", () => {
    setup({ activeScenarioId: null, savedTrackIds: {}, offsetsByHex: {} });
    expect(screen.getByLabelText("Add HELI002 to scenario")).toBeDisabled();
  });

  it("shows a saved track's start offset", () => {
    setup();
    expect(screen.getByLabelText("HELI001 start offset seconds")).toHaveValue(90);
  });

  // The offset input is controlled by `offsetsByHex`, so `fireEvent.change`
  // sets a value directly rather than user-event appending to the existing one.
  it("edits a saved track's start offset", () => {
    const scenario = setup();

    fireEvent.change(screen.getByLabelText("HELI001 start offset seconds"), {
      target: { value: "45" },
    });

    expect(scenario.onOffsetChange).toHaveBeenCalledWith("track-1", 45);
  });

  it("treats a cleared offset field as zero rather than NaN", () => {
    const scenario = setup();

    fireEvent.change(screen.getByLabelText("HELI001 start offset seconds"), {
      target: { value: "" },
    });

    expect(scenario.onOffsetChange).toHaveBeenLastCalledWith("track-1", 0);
  });

  it("removes a saved track from the scenario", async () => {
    const user = userEvent.setup();
    const scenario = setup();

    await user.click(screen.getByLabelText("Remove HELI001 from scenario"));
    expect(scenario.onRemoveFromScenario).toHaveBeenCalledWith("track-1");
  });

  it("does not offer Remove for a staged trajectory", () => {
    setup();
    expect(screen.queryByLabelText("Remove HELI002 from scenario")).not.toBeInTheDocument();
  });

  it("shows no scenario controls at all when the panel has no scenario prop", () => {
    render(
      <SimulationPanel
        receiverLocation={RECEIVER}
        trajectories={[STAGED]}
        playback={{} as PlaybackMap}
        onTrajectories={vi.fn()}
        onStart={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onSeek={vi.fn()}
        showSimulation={false}
        onToggleSimulation={vi.fn()}
        simulationCount={0}
      />,
    );

    expect(screen.queryByText("unsaved")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Add HELI002 to scenario")).not.toBeInTheDocument();
  });

  describe("Clear", () => {
    // Clear discards only unsaved results now that scenario tracks share the
    // list, so it must not look live when there is nothing left to discard.
    it("is enabled while an unsaved trajectory is listed", () => {
      setup();
      expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
    });

    it("is disabled when every listed trajectory is already saved", () => {
      setup(
        {
          savedTrackIds: { "SIM-SAVED": "track-1" },
          offsetsByHex: { "SIM-SAVED": 0 },
        },
        [SAVED],
      );
      expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    });

    it("discards only the staged trajectories", async () => {
      const user = userEvent.setup();
      const onTrajectories = vi.fn();
      render(
        <SimulationPanel
          receiverLocation={RECEIVER}
          trajectories={[SAVED, STAGED]}
          playback={{} as PlaybackMap}
          onTrajectories={onTrajectories}
          onStart={vi.fn()}
          onPause={vi.fn()}
          onResume={vi.fn()}
          onStop={vi.fn()}
          onSeek={vi.fn()}
          showSimulation={false}
          onToggleSimulation={vi.fn()}
          simulationCount={0}
          scenario={{
            bar: null,
            savedTrackIds: { "SIM-SAVED": "track-1" },
            offsetsByHex: { "SIM-SAVED": 0 },
            activeScenarioId: "s1",
            onAddToScenario: vi.fn(),
            onRemoveFromScenario: vi.fn(),
            onOffsetChange: vi.fn(),
          }}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Clear" }));

      // The panel hands back an empty *staged* set; page.tsx keeps the
      // scenario's own tracks, which do not flow through this callback.
      expect(onTrajectories).toHaveBeenCalledWith([]);
    });
  });

  it("keeps the per-track transport available alongside the scenario", () => {
    // Offsets are optional: authoring one aircraft at a time must still work.
    setup();
    expect(screen.getByRole("group", { name: "Playback controls" })).toBeInTheDocument();
  });
});

import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SimulationPanel } from "@/components/SimulationPanel";
import type { AgentTrajectory } from "@/lib/simulation-data";
import type { PlaybackMap } from "@/lib/trajectory-playback";

vi.mock("@/lib/simulate-api", () => ({ simulateTrajectory: vi.fn() }));
import { simulateTrajectory } from "@/lib/simulate-api";
const mockSimulate = vi.mocked(simulateTrajectory);

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

const A = traj("SIM-A1", "HELI001");
const B = traj("SIM-B2", "HELI002");

function setup(over: Partial<Parameters<typeof SimulationPanel>[0]> = {}) {
  const handlers = {
    onToggleSimulation: vi.fn(),
    onToggleVisibility: vi.fn(),
    onToggleAllVisibility: vi.fn(),
    onTrajectories: vi.fn(),
    onStart: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onStop: vi.fn(),
    onSeek: vi.fn(),
  };
  const props = {
    receiverLocation: RECEIVER,
    trajectories: [] as AgentTrajectory[],
    playback: {} as PlaybackMap,
    showSimulation: false,
    simulationCount: 0,
    ...handlers,
    ...over,
  };
  const view = render(<SimulationPanel {...props} />);
  // Lets a test feed in trajectories the way the page does — the chat path
  // hands them down as props rather than through the panel's own form.
  const rerender = (next: Partial<typeof props>) =>
    view.rerender(<SimulationPanel {...props} {...next} />);
  return { ...handlers, rerender };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSimulate.mockResolvedValue({
    aircraft: [A],
    violations: [],
    summary: "1 aircraft (helicopter), 86 waypoints, 11 min",
  });
});

describe("SimulationPanel — generation", () => {
  it("renders the form controls", () => {
    setup();
    expect(screen.getByLabelText(/aircraft type/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/how many/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate/i })).toBeInTheDocument();
  });

  it("sends the selected form values", async () => {
    const user = userEvent.setup();
    setup();
    await user.selectOptions(screen.getByLabelText(/aircraft type/i), "fighter");
    await user.clear(screen.getByLabelText(/how many/i));
    await user.type(screen.getByLabelText(/how many/i), "3");
    await user.type(screen.getByLabelText(/route description/i), "aerobatics overhead");
    await user.click(screen.getByRole("button", { name: /generate/i }));

    await waitFor(() => expect(mockSimulate).toHaveBeenCalled());
    expect(mockSimulate.mock.calls[0][0]).toMatchObject({
      category: "fighter",
      count: 3,
      routeHint: "aerobatics overhead",
      originLat: RECEIVER.lat,
      originLng: RECEIVER.lng,
    });
  });

  it("passes generated aircraft to the caller", async () => {
    const user = userEvent.setup();
    const { onTrajectories } = setup();
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(onTrajectories).toHaveBeenCalledWith([A]));
  });

  it("omits an empty route hint", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(mockSimulate).toHaveBeenCalled());
    expect(mockSimulate.mock.calls[0][0].routeHint).toBeUndefined();
  });

  it("clamps the count", async () => {
    const user = userEvent.setup();
    setup();
    await user.clear(screen.getByLabelText(/how many/i));
    await user.type(screen.getByLabelText(/how many/i), "99");
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(mockSimulate).toHaveBeenCalled());
    expect(mockSimulate.mock.calls[0][0].count).toBeLessThanOrEqual(20);
  });

  it("surfaces a failure and does not push trajectories", async () => {
    const user = userEvent.setup();
    mockSimulate.mockRejectedValue(new Error("Could not reach the agent"));
    const { onTrajectories } = setup();
    await user.click(screen.getByRole("button", { name: /generate/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach/i);
    expect(onTrajectories).not.toHaveBeenCalled();
  });

  describe("without a receiver location", () => {
    it("explains why and disables generate", () => {
      setup({ receiverLocation: null });
      expect(screen.getByText(/set a receiver location/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /generate/i })).toBeDisabled();
    });
  });
});

describe("SimulationPanel — trajectory list", () => {
  it("is absent when nothing has been generated", () => {
    setup();
    expect(screen.queryByText(/^Trajectories$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^start$/i })).not.toBeInTheDocument();
  });

  it("lists each generated trajectory", () => {
    setup({ trajectories: [A, B] });
    expect(screen.getByText("HELI001")).toBeInTheDocument();
    expect(screen.getByText("HELI002")).toBeInTheDocument();
  });

  it("shows the count", () => {
    setup({ trajectories: [A, B] });
    expect(screen.getByText("(2)")).toBeInTheDocument();
  });

  it("shows waypoint count, duration, altitude range and phases", () => {
    setup({ trajectories: [A] });
    const row = screen.getByRole("listitem");
    expect(row.textContent).toContain("2 wp");
    expect(row.textContent).toContain("2:00");
    expect(row.textContent).toContain("1200–1400 ft");
    expect(row.textContent).toContain("loiter");
  });

  it("reports playback state per trajectory", () => {
    const playback: PlaybackMap = {
      "SIM-A1": { state: "playing", elapsedS: 30 },
      "SIM-B2": { state: "paused", elapsedS: 10 },
    };
    setup({ trajectories: [A, B], playback });
    expect(screen.getByText("playing")).toBeInTheDocument();
    expect(screen.getByText("paused")).toBeInTheDocument();
  });

  it("shows stopped for trajectories with no entry", () => {
    setup({ trajectories: [A] });
    expect(screen.getByText("stopped")).toBeInTheDocument();
  });

  it("clears the list", async () => {
    const user = userEvent.setup();
    const { onTrajectories } = setup({ trajectories: [A] });
    await user.click(screen.getByRole("button", { name: /clear/i }));
    expect(onTrajectories).toHaveBeenCalledWith([]);
  });
});

describe("SimulationPanel — selection", () => {
  it("selects trajectories as they arrive", async () => {
    /* Regression: arriving trajectories were never selected, and every
       transport button acts on the selection alone — so chat-generated
       aircraft landed in the list with all controls inert. */
    const user = userEvent.setup();
    const { onStart, rerender } = setup({ trajectories: [] });
    rerender({ trajectories: [A, B] });

    expect(screen.getByLabelText("Select HELI001")).toBeChecked();
    await user.click(screen.getByRole("button", { name: /^start$/i }));
    expect(onStart).toHaveBeenCalledWith(["SIM-A1", "SIM-B2"]);
  });

  it("selects arrivals under StrictMode", () => {
    /* The rule is a render-phase state adjustment, and Next.js enables
       StrictMode by default — double-rendering must not lose the selection. */
    const props = {
      receiverLocation: RECEIVER,
      trajectories: [] as AgentTrajectory[],
      playback: {} as PlaybackMap,
      onTrajectories: vi.fn(),
      onStart: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onStop: vi.fn(),
      onSeek: vi.fn(),
      showSimulation: false,
      onToggleSimulation: vi.fn(),
      simulationCount: 0,
    };
    const view = render(
      <StrictMode>
        <SimulationPanel {...props} />
      </StrictMode>,
    );
    view.rerender(
      <StrictMode>
        <SimulationPanel {...props} trajectories={[A, B]} />
      </StrictMode>,
    );
    expect(screen.getByLabelText("Select HELI001")).toBeChecked();
    expect(screen.getByLabelText("Select HELI002")).toBeChecked();
  });

  it("selects aircraft generated from the form", async () => {
    /* So Start works immediately after Generate, without an extra click. */
    const user = userEvent.setup();
    const { rerender } = setup({ trajectories: [] });
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(mockSimulate).toHaveBeenCalled());

    rerender({ trajectories: [A] });
    expect(screen.getByLabelText("Select HELI001")).toBeChecked();
  });

  it("respects a deselection across re-renders", async () => {
    /* Auto-select must apply to NEW ids only, or it would fight the user. */
    const user = userEvent.setup();
    const { rerender } = setup({ trajectories: [A, B] });
    await user.click(screen.getByLabelText("Select HELI001"));
    expect(screen.getByLabelText("Select HELI001")).not.toBeChecked();

    rerender({ trajectories: [A, B], playback: { "SIM-A1": { state: "stopped", elapsedS: 0 } } });
    expect(screen.getByLabelText("Select HELI001")).not.toBeChecked();
  });

  it("selects only the newly added trajectory", async () => {
    const user = userEvent.setup();
    const { rerender } = setup({ trajectories: [A] });
    await user.click(screen.getByLabelText("Select HELI001"));

    rerender({ trajectories: [A, B] });
    expect(screen.getByLabelText("Select HELI001")).not.toBeChecked();
    expect(screen.getByLabelText("Select HELI002")).toBeChecked();
  });

  it("toggles an individual trajectory", async () => {
    /* Everything arrives selected, so one click deselects. */
    const user = userEvent.setup();
    const { onStart } = setup({ trajectories: [A, B] });
    await user.click(screen.getByLabelText("Select HELI002"));
    await user.click(screen.getByRole("button", { name: /^start$/i }));
    expect(onStart).toHaveBeenCalledWith(["SIM-A1"]);
  });

  it("selects all", async () => {
    const user = userEvent.setup();
    const { onStart } = setup({ trajectories: [A, B] });
    const all = screen.getByLabelText(/select all/i);
    await user.click(all); // clear (they arrive selected)
    await user.click(all); // and select everything again
    await user.click(screen.getByRole("button", { name: /^start$/i }));
    expect(onStart).toHaveBeenCalledWith(["SIM-A1", "SIM-B2"]);
  });

  it("deselects all when already all selected", async () => {
    const user = userEvent.setup();
    setup({ trajectories: [A, B] });
    await user.click(screen.getByLabelText(/select all/i));
    expect(screen.getByText(/select a trajectory to control/i)).toBeInTheDocument();
  });

  it("prompts when the user has cleared the selection", async () => {
    const user = userEvent.setup();
    setup({ trajectories: [A] });
    await user.click(screen.getByLabelText("Select HELI001"));
    expect(screen.getByText(/select a trajectory to control/i)).toBeInTheDocument();
  });
});

describe("SimulationPanel — transport controls", () => {
  const playbackOf = (state: "stopped" | "playing" | "paused"): PlaybackMap => ({
    "SIM-A1": { state, elapsedS: state === "stopped" ? 0 : 30 },
  });

  // Trajectories arrive selected, so the transport tests need no click.
  async function selectFirst(_user: ReturnType<typeof userEvent.setup>) {}

  it("offers all four transport actions", () => {
    setup({ trajectories: [A] });
    for (const name of ["Start", "Pause", "Resume", "Stop"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("enables only Start for a stopped trajectory", async () => {
    const user = userEvent.setup();
    setup({ trajectories: [A], playback: playbackOf("stopped") });
    await selectFirst(user);
    expect(screen.getByRole("button", { name: "Start" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  });

  it("enables Pause and Stop while playing", async () => {
    const user = userEvent.setup();
    setup({ trajectories: [A], playback: playbackOf("playing") });
    await selectFirst(user);
    expect(screen.getByRole("button", { name: "Pause" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
  });

  it("enables Resume and Stop while paused", async () => {
    const user = userEvent.setup();
    setup({ trajectories: [A], playback: playbackOf("paused") });
    await selectFirst(user);
    expect(screen.getByRole("button", { name: "Resume" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
  });

  it("disables every action with an empty selection", async () => {
    const user = userEvent.setup();
    setup({ trajectories: [A], playback: playbackOf("playing") });
    await user.click(screen.getByLabelText("Select HELI001")); // clear the auto-selection
    for (const name of ["Start", "Pause", "Resume", "Stop"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it.each([
    ["Start", "onStart", "stopped"],
    ["Pause", "onPause", "playing"],
    ["Resume", "onResume", "paused"],
    ["Stop", "onStop", "playing"],
  ] as const)("%s calls %s with the selection", async (label, handler, required) => {
    const user = userEvent.setup();
    // Each action is only enabled when the selection contains a trajectory in
    // the state it applies to.
    const handlers = setup({
      trajectories: [A, B],
      playback: {
        "SIM-A1": { state: required, elapsedS: required === "stopped" ? 0 : 5 },
        "SIM-B2": { state: required, elapsedS: required === "stopped" ? 0 : 5 },
      },
    });
    // They arrive selected, so the action applies to both straight away.
    await user.click(screen.getByRole("button", { name: label }));
    expect(handlers[handler]).toHaveBeenCalledWith(["SIM-A1", "SIM-B2"]);
  });
});

describe("SimulationPanel — time scrubber", () => {
  it("renders a timeline per trajectory", () => {
    setup({ trajectories: [A, B] });
    expect(screen.getAllByRole("slider")).toHaveLength(2);
  });

  it("spans the trajectory duration", () => {
    setup({ trajectories: [A] });
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "120");
  });

  it("shows the clock position", () => {
    setup({ trajectories: [A], playback: { "SIM-A1": { state: "playing", elapsedS: 45 } } });
    expect(screen.getByRole("slider")).toHaveValue("45");
    expect(screen.getByText("0:45/2:00")).toBeInTheDocument();
  });

  it("seeks on drag", async () => {
    const { onSeek } = setup({ trajectories: [A] });
    const slider = screen.getByRole("slider");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(slider, { target: { value: "60" } });
    expect(onSeek).toHaveBeenCalledWith("SIM-A1", 60);
  });

  it("labels the slider by callsign", () => {
    setup({ trajectories: [A] });
    expect(screen.getByLabelText("HELI001 timeline")).toBeInTheDocument();
  });

  it("avoids a zero-width range for an instantaneous trajectory", () => {
    const instant: AgentTrajectory = {
      ...A,
      waypoints: [A.waypoints[0]],
    };
    setup({ trajectories: [instant] });
    expect(Number(screen.getByRole("slider").getAttribute("max"))).toBeGreaterThan(0);
  });
});

/**
 * The demo-flight layer is a *different* data source from agent trajectories
 * (20 hardcoded routes in `useSimulatedTracks`). It moved here from the Filters
 * panel because it is the cheapest way to put aircraft on the map — but the two
 * sources stay independent, which is what the last assertion pins.
 */
describe("SimulationPanel — demo flights shortcut", () => {
  it("renders the toggle", () => {
    setup();
    expect(screen.getByLabelText(/demo flights/i)).not.toBeChecked();
  });

  it("shows the live count only while enabled", () => {
    const { rerender } = setup({ simulationCount: 20 });
    expect(screen.queryByText(/20 sim/)).not.toBeInTheDocument();
    rerender({ showSimulation: true, simulationCount: 20 });
    expect(screen.getByText(/20 sim/)).toBeInTheDocument();
  });

  it("calls onToggleSimulation when clicked", async () => {
    const user = userEvent.setup();
    const { onToggleSimulation } = setup();
    await user.click(screen.getByLabelText(/demo flights/i));
    expect(onToggleSimulation).toHaveBeenCalledTimes(1);
  });

  it("does not touch agent playback", async () => {
    const user = userEvent.setup();
    const { onStart, onStop, onTrajectories } = setup({ trajectories: [A] });
    await user.click(screen.getByLabelText(/demo flights/i));
    expect(onStart).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    expect(onTrajectories).not.toHaveBeenCalled();
  });
});

describe("SimulationPanel — generation fold", () => {
  const fold = () =>
    screen.getByText("Generate trajectories").closest("details") as HTMLDetailsElement;

  beforeEach(() => window.localStorage.clear());

  it("starts open when there is nothing generated yet", () => {
    setup();
    expect(fold().open).toBe(true);
  });

  it("starts closed once trajectories exist, to make room for the list", () => {
    setup({ trajectories: [A, B] });
    expect(fold().open).toBe(false);
  });

  it("remembers a deliberate choice and lets it beat the derived default", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText("Generate trajectories"));
    expect(fold().open).toBe(false);
    expect(window.localStorage.getItem("adsb-sim-generate-open")).toBe("false");
  });

  it("keeps a stored preference across a remount with trajectories present", () => {
    window.localStorage.setItem("adsb-sim-generate-open", "true");
    setup({ trajectories: [A] });
    expect(fold().open).toBe(true);
  });
});

/**
 * Show/hide is a third axis, independent of both the selection checkbox (which
 * targets transport) and the transport state itself.
 */
describe("SimulationPanel — map visibility", () => {
  it("offers an eye per trajectory", () => {
    setup({ trajectories: [A, B] });
    expect(screen.getByLabelText("Hide HELI001 from map")).toBeInTheDocument();
    expect(screen.getByLabelText("Hide HELI002 from map")).toBeInTheDocument();
  });

  it("reports the hex when a row eye is clicked", async () => {
    const user = userEvent.setup();
    const { onToggleVisibility } = setup({ trajectories: [A, B] });
    await user.click(screen.getByLabelText("Hide HELI002 from map"));
    expect(onToggleVisibility).toHaveBeenCalledWith("SIM-B2");
  });

  it("flips the row eye label for an already hidden trajectory", () => {
    setup({ trajectories: [A, B], hiddenHexes: new Set(["SIM-A1"]) });
    expect(screen.getByLabelText("Show HELI001 on map")).toBeInTheDocument();
    expect(screen.getByLabelText("Hide HELI002 from map")).toBeInTheDocument();
  });

  it("hides all trajectories from the group eye", async () => {
    const user = userEvent.setup();
    const { onToggleAllVisibility } = setup({ trajectories: [A, B] });
    await user.click(screen.getByLabelText("Hide all trajectories from map"));
    expect(onToggleAllVisibility).toHaveBeenCalledWith(["SIM-A1", "SIM-B2"]);
  });

  it("reads as show-all only when every trajectory is hidden", () => {
    const { rerender } = setup({ trajectories: [A, B], hiddenHexes: new Set(["SIM-A1"]) });
    // One of two hidden is still "hide all" — the group eye follows the majority
    // rule used by the aircraft table, not a partial state.
    expect(screen.getByLabelText("Hide all trajectories from map")).toBeInTheDocument();
    rerender({ hiddenHexes: new Set(["SIM-A1", "SIM-B2"]) });
    expect(screen.getByLabelText("Show all trajectories on map")).toBeInTheDocument();
  });

  it("never touches transport when hiding", async () => {
    const user = userEvent.setup();
    const { onStart, onPause, onResume, onStop, onSeek } = setup({ trajectories: [A, B] });
    await user.click(screen.getByLabelText("Hide HELI001 from map"));
    await user.click(screen.getByLabelText("Hide all trajectories from map"));
    for (const fn of [onStart, onPause, onResume, onStop, onSeek]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("does not change the selection when hiding", async () => {
    const user = userEvent.setup();
    setup({ trajectories: [A, B] });
    expect(screen.getByLabelText("Select HELI001")).toBeChecked();
    await user.click(screen.getByLabelText("Hide HELI001 from map"));
    expect(screen.getByLabelText("Select HELI001")).toBeChecked();
  });

  it("omits the eyes entirely when no visibility handlers are supplied", () => {
    render(
      <SimulationPanel
        receiverLocation={RECEIVER}
        trajectories={[A]}
        playback={{} as PlaybackMap}
        showSimulation={false}
        simulationCount={0}
        onToggleSimulation={vi.fn()}
        onTrajectories={vi.fn()}
        onStart={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onSeek={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/from map/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/on map/)).not.toBeInTheDocument();
  });
});

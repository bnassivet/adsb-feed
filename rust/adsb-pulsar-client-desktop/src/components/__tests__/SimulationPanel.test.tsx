import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
    onTrajectories: vi.fn(),
    onStart: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onStop: vi.fn(),
    onSeek: vi.fn(),
  };
  render(
    <SimulationPanel
      receiverLocation={RECEIVER}
      trajectories={[]}
      playback={{}}
      {...handlers}
      {...over}
    />,
  );
  return handlers;
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
  it("selects newly generated aircraft automatically", async () => {
    /* So Start works immediately after Generate, without an extra click. */
    const user = userEvent.setup();
    setup({ trajectories: [] });
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(mockSimulate).toHaveBeenCalled());
  });

  it("toggles an individual trajectory", async () => {
    const user = userEvent.setup();
    const { onStart } = setup({ trajectories: [A, B] });
    await user.click(screen.getByLabelText("Select HELI001"));
    await user.click(screen.getByRole("button", { name: /^start$/i }));
    expect(onStart).toHaveBeenCalledWith(["SIM-A1"]);
  });

  it("selects all", async () => {
    const user = userEvent.setup();
    const { onStart } = setup({ trajectories: [A, B] });
    await user.click(screen.getByLabelText(/select all/i));
    await user.click(screen.getByRole("button", { name: /^start$/i }));
    expect(onStart).toHaveBeenCalledWith(["SIM-A1", "SIM-B2"]);
  });

  it("deselects all when already all selected", async () => {
    const user = userEvent.setup();
    setup({ trajectories: [A, B] });
    const all = screen.getByLabelText(/select all/i);
    await user.click(all);
    await user.click(all);
    expect(screen.getByText(/select a trajectory to control/i)).toBeInTheDocument();
  });

  it("prompts when nothing is selected", () => {
    setup({ trajectories: [A] });
    expect(screen.getByText(/select a trajectory to control/i)).toBeInTheDocument();
  });
});

describe("SimulationPanel — transport controls", () => {
  const playbackOf = (state: "stopped" | "playing" | "paused"): PlaybackMap => ({
    "SIM-A1": { state, elapsedS: state === "stopped" ? 0 : 30 },
  });

  async function selectFirst(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByLabelText("Select HELI001"));
  }

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

  it("disables every action with an empty selection", () => {
    setup({ trajectories: [A], playback: playbackOf("playing") });
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
    await user.click(screen.getByLabelText(/select all/i));
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

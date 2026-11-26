import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenSkyControls, describeOpenSkyService, type OpenSkyControlsProps } from "../OpenSkyControls";
import type { OpenSkyStatus } from "@/lib/opensky";

const NOW = 1_764_000_000_000;

function status(over: Partial<OpenSkyStatus> = {}): OpenSkyStatus {
  return {
    version: 1,
    enabled: true,
    authenticated: true,
    state: "waiting",
    watch: { icao24: 1, areas: 0, clients: 1 },
    interval_seconds: 24,
    cycle_cost: 1,
    credits: { daily_limit: 4000, states_used_24h: 10, tracks_used_24h: 0 },
    consecutive_failures: 0,
    updated_at_ms: NOW,
    ...over,
  };
}

function props(over: Partial<OpenSkyControlsProps> = {}): OpenSkyControlsProps {
  return {
    show: true,
    onToggle: vi.fn(),
    mode: "gaps",
    onModeChange: vi.fn(),
    areas: [],
    onDrawArea: vi.fn(),
    onRemoveArea: vi.fn(),
    watched: [],
    shownCount: 0,
    service: { status: status(), availability: "online" },
    pendingEnabled: null,
    serviceError: null,
    watchError: null,
    onServiceToggle: vi.fn(),
    nowMs: NOW,
    ...over,
  };
}

describe("OpenSkyControls", () => {
  it("shows only the switch while the layer is off", () => {
    render(<OpenSkyControls {...props({ show: false })} />);
    expect(screen.getByLabelText("Fill gaps from OpenSky")).not.toBeChecked();
    expect(screen.queryByText("Draw area")).toBeNull();
  });

  it("says what the poller is doing and what it costs", () => {
    render(<OpenSkyControls {...props()} />);
    expect(screen.getByText("Polling every 24 s (1 credit a poll)")).toBeInTheDocument();
  });

  it("switches mode", async () => {
    const onModeChange = vi.fn();
    render(<OpenSkyControls {...props({ onModeChange })} />);
    await userEvent.click(screen.getByRole("button", { name: "Always" }));
    expect(onModeChange).toHaveBeenCalledWith("always");
    expect(screen.getByRole("button", { name: "Gaps only" })).toHaveAttribute("aria-pressed", "true");
  });

  it("warns when an area costs more than one credit and flags a refused one", () => {
    render(
      <OpenSkyControls
        {...props({
          areas: [
            { id: "small", north: 48, south: 46, east: 0, west: -3 },
            { id: "mid", north: 50, south: 45, east: 5, west: -5 },
            { id: "huge", north: 60, south: 40, east: 10, west: -10 },
          ],
        })}
      />,
    );
    expect(screen.getByText(/small · 6.0 sq° · 1 credit\/poll/)).toHaveClass("text-slate-400");
    expect(screen.getByText(/mid · 50.0 sq° · 2 credits\/poll/)).toHaveClass("text-amber-400");
    expect(screen.getByText(/huge .* too large, refused/)).toHaveClass("text-red-400");
  });

  it("draws and removes areas, up to four", async () => {
    const onDrawArea = vi.fn();
    const onRemoveArea = vi.fn();
    const area = (id: string) => ({ id, north: 48, south: 46, east: 0, west: -3 });
    const { rerender } = render(
      <OpenSkyControls {...props({ onDrawArea, onRemoveArea, areas: [area("a1")] })} />,
    );
    await userEvent.click(screen.getByText("Draw area"));
    expect(onDrawArea).toHaveBeenCalled();
    await userEvent.click(screen.getByLabelText("Remove area a1"));
    expect(onRemoveArea).toHaveBeenCalledWith("a1");
    rerender(<OpenSkyControls {...props({ areas: ["a", "b", "c", "d"].map(area) })} />);
    expect(screen.getByText("Draw area")).toBeDisabled();
  });

  it("pauses polling through the service and shows it pending", async () => {
    const onServiceToggle = vi.fn();
    const { rerender } = render(<OpenSkyControls {...props({ onServiceToggle })} />);
    await userEvent.click(screen.getByLabelText("Poll OpenSky"));
    expect(onServiceToggle).toHaveBeenCalledWith(false);
    rerender(<OpenSkyControls {...props({ pendingEnabled: false })} />);
    expect(screen.getByText("pausing…")).toBeInTheDocument();
  });

  it("explains an anonymous service and an offline one", () => {
    const { rerender } = render(
      <OpenSkyControls {...props({ service: { status: status({ authenticated: false }), availability: "online" } })} />,
    );
    expect(screen.getByText(/Anonymous: 400 credits a day/)).toBeInTheDocument();
    rerender(<OpenSkyControls {...props({ service: { status: null, availability: "offline" } })} />);
    expect(screen.getByText("OpenSky service offline")).toBeInTheDocument();
  });
});

describe("describeOpenSkyService", () => {
  it("counts a rate-limit deadline in minutes", () => {
    const line = describeOpenSkyService(
      { status: status({ state: "rate_limited", rate_limited_until_ms: NOW + 290_000 }), availability: "online" },
      NOW,
    );
    expect(line).toEqual({ text: "Rate limited by OpenSky, retry in 5 min", tone: "warn" });
  });

  it("names refused credentials as an error", () => {
    expect(
      describeOpenSkyService({ status: status({ state: "unauthorized" }), availability: "online" }, NOW)?.tone,
    ).toBe("error");
  });
});

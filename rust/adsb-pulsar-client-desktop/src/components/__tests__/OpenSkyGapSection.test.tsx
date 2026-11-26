import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenSkyGapSection, type OpenSkyDetails } from "../OpenSkyGapSection";

const NOW = 1_764_000_000_000;

function props(over: Partial<OpenSkyDetails> = {}): OpenSkyDetails {
  return {
    lastOpenSkyMs: null,
    watched: false,
    backfill: null,
    disabledReason: null,
    onBackfill: vi.fn(),
    onClearBackfill: vi.fn(),
    hidden: false,
    onToggleHidden: vi.fn(),
    followed: false,
    onToggleFollow: vi.fn(),
    nowMs: NOW,
    ...over,
  };
}

describe("OpenSkyGapSection", () => {
  it("says how old OpenSky's last position is", () => {
    render(<OpenSkyGapSection {...props({ lastOpenSkyMs: NOW - 12_000 })} />);
    expect(screen.getByText("Last OpenSky position 12 s ago")).toBeInTheDocument();
  });

  it("says when the aircraft is being followed but not placed yet", () => {
    render(<OpenSkyGapSection {...props({ followed: true, watched: true })} />);
    expect(screen.getByText("Following through OpenSky…")).toBeInTheDocument();
  });

  it("follows only on request, and says when a followed aircraft is not asked for yet", async () => {
    const onToggleFollow = vi.fn();
    const { rerender } = render(<OpenSkyGapSection {...props({ onToggleFollow })} />);
    expect(screen.getByText("Not followed: select Follow to ask OpenSky for it")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Follow on OpenSky" }));
    expect(onToggleFollow).toHaveBeenCalledTimes(1);
    rerender(<OpenSkyGapSection {...props({ onToggleFollow, followed: true })} />);
    expect(screen.getByText(/Followed: asked for once the receiver loses it/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop following" }));
    expect(onToggleFollow).toHaveBeenCalledTimes(2);
  });

  it("cannot follow a simulated aircraft or through an unreachable service", () => {
    render(<OpenSkyGapSection {...props({ followUnavailable: "OpenSky service not reachable" })} />);
    expect(screen.getByRole("button", { name: "Follow on OpenSky" })).toBeDisabled();
  });

  it("backfills on click and shows progress", async () => {
    const onBackfill = vi.fn();
    const { rerender } = render(<OpenSkyGapSection {...props({ onBackfill })} />);
    await userEvent.click(screen.getByText("Fill gaps (OpenSky)"));
    expect(onBackfill).toHaveBeenCalled();
    rerender(<OpenSkyGapSection {...props({ backfill: { kind: "loading" } })} />);
    expect(screen.getByText("Fetching…")).toBeDisabled();
  });

  it("is disabled with a reason", () => {
    render(<OpenSkyGapSection {...props({ disabledReason: "Simulated aircraft: nothing is sent to OpenSky" })} />);
    expect(screen.getByText("Fill gaps (OpenSky)")).toBeDisabled();
    expect(screen.getByText("Simulated aircraft: nothing is sent to OpenSky")).toBeInTheDocument();
  });

  it("reports the outcome and hides the track on request", async () => {
    const onClearBackfill = vi.fn();
    const track = {
      icao24: "3c6444",
      start_time: 1_763_990_000,
      end_time: 0,
      path: [
        { time: 1, latitude: 47, longitude: -1, on_ground: false },
        { time: 2, latitude: 47.5, longitude: -1.5, on_ground: false },
      ],
    };
    const { rerender } = render(
      <OpenSkyGapSection {...props({ onClearBackfill, backfill: { kind: "done", track } })} />,
    );
    expect(screen.getByText(/2 waypoints since/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onClearBackfill).toHaveBeenCalled();
    rerender(<OpenSkyGapSection {...props({ backfill: { kind: "none" } })} />);
    expect(screen.getByText("OpenSky has no live track for this aircraft.")).toBeInTheDocument();
    rerender(<OpenSkyGapSection {...props({ backfill: { kind: "error", message: "HTTP 429" } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP 429");
  });

  it("hides a backfilled track without discarding it, and shows it again", async () => {
    const onToggleHidden = vi.fn();
    const onClearBackfill = vi.fn();
    const track = { icao24: "3c6444", start_time: 0, end_time: 0, path: [] };
    const { rerender } = render(
      <OpenSkyGapSection {...props({ onToggleHidden, onClearBackfill, backfill: { kind: "done", track } })} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Hide track" }));
    expect(onToggleHidden).toHaveBeenCalledTimes(1);
    expect(onClearBackfill).not.toHaveBeenCalled();
    rerender(
      <OpenSkyGapSection {...props({ hidden: true, onToggleHidden, onClearBackfill, backfill: { kind: "done", track } })} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Show track" }));
    expect(onToggleHidden).toHaveBeenCalledTimes(2);
  });
});

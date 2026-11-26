import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenSkyHistorySection, type OpenSkyHistoryDetails } from "../OpenSkyHistorySection";

function props(over: Partial<OpenSkyHistoryDetails> = {}): OpenSkyHistoryDetails {
  return { entry: null, unavailable: null, cost: 4, onFetch: vi.fn(), hidden: false, onToggleHidden: vi.fn(), onDiscard: vi.fn(), ...over };
}

const done = {
  kind: "done" as const,
  track: { icao24: "3c6444", callsign: "DLH9LF", start_time: 1_764_000_000, end_time: 1_764_003_600, path: [] },
  gaps: { count: 3, seconds: 840, segments: [] },
  stored: false,
};

describe("OpenSkyHistorySection", () => {
  it("offers the fetch with its credit cost", async () => {
    const onFetch = vi.fn();
    render(<OpenSkyHistorySection {...props({ onFetch, cost: 30 })} />);
    const button = screen.getByRole("button", { name: "Fetch from OpenSky" });
    expect(button).toHaveAttribute("title", expect.stringContaining("30 credits"));
    await userEvent.click(button);
    expect(onFetch).toHaveBeenCalled();
  });

  it("is disabled, and says why, when a fetch is impossible", () => {
    render(<OpenSkyHistorySection {...props({ unavailable: "OpenSky keeps tracks for 30 days only" })} />);
    expect(screen.getByRole("button", { name: "Fetch from OpenSky" })).toBeDisabled();
    expect(screen.getByText("OpenSky keeps tracks for 30 days only")).toBeInTheDocument();
  });

  it("summarises a fetched flight, hides it without discarding it, and discards it", async () => {
    const onToggleHidden = vi.fn();
    const onDiscard = vi.fn();
    const { rerender } = render(<OpenSkyHistorySection {...props({ entry: done, onToggleHidden, onDiscard })} />);
    expect(screen.getByText(/DLH9LF/)).toBeInTheDocument();
    expect(screen.getByText("3 gaps filled, 14 min")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(onToggleHidden).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
    rerender(<OpenSkyHistorySection {...props({ entry: done, hidden: true, onToggleHidden, onDiscard })} />);
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(onToggleHidden).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalled();
  });

  it("says when the flight came from storage, so no credits were spent", () => {
    const { rerender } = render(<OpenSkyHistorySection {...props({ entry: { ...done, stored: true } })} />);
    expect(screen.getByText("From storage: no credits spent")).toBeInTheDocument();
    rerender(<OpenSkyHistorySection {...props({ entry: done })} />);
    expect(screen.queryByText(/From storage/)).not.toBeInTheDocument();
  });

  it("says when the flight was fully covered", () => {
    render(<OpenSkyHistorySection {...props({ entry: { ...done, gaps: { count: 0, seconds: 0, segments: [] } } })} />);
    expect(screen.getByText("No gap: the receiver heard all of it")).toBeInTheDocument();
  });

  it("explains a mismatch, a missing flight and an error", () => {
    const { rerender } = render(
      <OpenSkyHistorySection {...props({ entry: { kind: "mismatch", reason: "its callsign is AFR1, not DLH9LF" } })} />,
    );
    expect(screen.getByText("OpenSky's flight doesn't match: its callsign is AFR1, not DLH9LF")).toBeInTheDocument();
    rerender(<OpenSkyHistorySection {...props({ entry: { kind: "none" } })} />);
    expect(screen.getByText("OpenSky has no track of this flight.")).toBeInTheDocument();
    rerender(<OpenSkyHistorySection {...props({ entry: { kind: "error", message: "boom" } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
  });

  it("shows progress while fetching", () => {
    render(<OpenSkyHistorySection {...props({ entry: { kind: "loading" } })} />);
    expect(screen.getByRole("button", { name: "Fetching…" })).toBeDisabled();
  });
});

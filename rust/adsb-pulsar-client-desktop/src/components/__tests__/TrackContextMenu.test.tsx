import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrackContextMenu } from "../TrackContextMenu";

describe("TrackContextMenu", () => {
  it("names the track, runs an item and closes", async () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(
      <TrackContextMenu x={10} y={20} title="DLH9LF · 3C6444" items={[{ label: "Follow on OpenSky", onSelect: run }]} onClose={onClose} />,
    );
    expect(screen.getByText("DLH9LF · 3C6444")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Follow on OpenSky" }));
    expect(run).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a disabled item with its reason, and does not run it", async () => {
    const run = vi.fn();
    render(
      <TrackContextMenu
        x={0}
        y={0}
        title="X"
        items={[{ label: "Fill gaps (OpenSky), 4 credits", onSelect: run, disabled: true, title: "Simulated aircraft" }]}
        onClose={vi.fn()}
      />,
    );
    const item = screen.getByRole("menuitem", { name: "Fill gaps (OpenSky), 4 credits" });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", "Simulated aircraft");
  });

  it("says when the track has nothing to offer", () => {
    render(<TrackContextMenu x={0} y={0} title="X" items={[]} onClose={vi.fn()} />);
    expect(screen.getByText("No OpenSky action for this track")).toBeInTheDocument();
  });

  it("closes on Escape and on a click outside", async () => {
    const onClose = vi.fn();
    render(
      <div>
        <p>outside</p>
        <TrackContextMenu x={0} y={0} title="X" items={[]} onClose={onClose} />
      </div>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByText("outside"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RadarTimeline, WHEEL_STEP_PX, type RadarTimelineProps } from "../RadarTimeline";

const T = Date.UTC(2026, 10, 19, 3, 0);
const frames = [0, 5, 10, 15].map((m) => ({ validTimeMs: T + m * 60_000, url: "" }));

function props(over: Partial<RadarTimelineProps> = {}): RadarTimelineProps {
  return { frames, index: 1, playing: true, onSeek: vi.fn(), onTogglePlay: vi.fn(), ...over };
}

describe("RadarTimeline", () => {
  it("shows the shown frame's offset from the latest, and its time", () => {
    render(<RadarTimeline {...props()} />);
    expect(screen.getByText("−10 min · 03:05 UTC")).toBeInTheDocument();
    expect(screen.getByText("−15 min")).toBeInTheDocument();
    expect(screen.getByText("latest")).toBeInTheDocument();
  });

  it("is a slider over the frames", () => {
    const p = props();
    render(<RadarTimeline {...p} />);
    const slider = screen.getByRole("slider", { name: /radar time/i });
    expect(slider).toHaveAttribute("max", "3");
    expect(slider).toHaveValue("1");
    fireEvent.change(slider, { target: { value: "3" } });
    expect(p.onSeek).toHaveBeenCalledWith(3);
  });

  it("plays and pauses", async () => {
    const p = props();
    const { rerender } = render(<RadarTimeline {...p} />);
    await userEvent.click(screen.getByRole("button", { name: /pause/i }));
    expect(p.onTogglePlay).toHaveBeenCalledOnce();
    rerender(<RadarTimeline {...p} playing={false} />);
    expect(screen.getByRole("button", { name: /play/i })).toBeInTheDocument();
  });

  it("scrolls a frame per wheel step: down is later, up is earlier, never past the ends", () => {
    const p = props();
    const { rerender } = render(<RadarTimeline {...p} />);
    const bar = screen.getByRole("group", { name: /radar timeline/i });
    fireEvent.wheel(bar, { deltaY: WHEEL_STEP_PX / 2 });
    expect(p.onSeek).not.toHaveBeenCalled();
    fireEvent.wheel(bar, { deltaY: WHEEL_STEP_PX / 2 });
    expect(p.onSeek).toHaveBeenLastCalledWith(2);
    fireEvent.wheel(bar, { deltaY: -WHEEL_STEP_PX });
    expect(p.onSeek).toHaveBeenLastCalledWith(0);
    rerender(<RadarTimeline {...p} index={0} />);
    (p.onSeek as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.wheel(bar, { deltaY: -WHEEL_STEP_PX });
    expect(p.onSeek).not.toHaveBeenCalled();
  });

  it("follows a horizontal scroll too", () => {
    const p = props();
    render(<RadarTimeline {...p} />);
    fireEvent.wheel(screen.getByRole("group", { name: /radar timeline/i }), { deltaX: WHEEL_STEP_PX, deltaY: 1 });
    expect(p.onSeek).toHaveBeenLastCalledWith(2);
  });
});

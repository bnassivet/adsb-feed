import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RadarControls, type RadarControlsProps } from "../RadarControls";

const T = Date.UTC(2026, 10, 19, 3, 10);

function props(over: Partial<RadarControlsProps> = {}): RadarControlsProps {
  return {
    show: true, onToggle: vi.fn(), validTimeMs: T, nowMs: T + 4 * 60_000, stale: false, loading: false,
    error: null, onReload: vi.fn(), opacity: 0.7, onOpacityChange: vi.fn(),
    scale: [{ fromMmH: 0.1, color: "#9bd3f5" }, { fromMmH: 1, color: "#4aa3f0" }],
    animate: false, onToggleAnimate: vi.fn(), frame: null, frameCount: 0,
    ...over,
  };
}

describe("RadarControls", () => {
  it("toggles the layer and hides the rest while off", async () => {
    const p = props({ show: false });
    render(<RadarControls {...p} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /rain radar/i }));
    expect(p.onToggle).toHaveBeenCalledOnce();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("shows the image time and age, and refreshes", async () => {
    const p = props();
    render(<RadarControls {...p} />);
    expect(screen.getByText(/Image 03:10 UTC · 4 min ago/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(p.onReload).toHaveBeenCalledOnce();
  });

  it("has an opacity slider", () => {
    const p = props();
    render(<RadarControls {...p} />);
    fireEvent.change(screen.getByRole("slider", { name: /opacity/i }), { target: { value: "40" } });
    expect(p.onOpacityChange).toHaveBeenCalledWith(0.4);
  });

  it("shows the legend from the image's own scale, in mm/h", () => {
    render(<RadarControls {...props()} />);
    expect(screen.getByText("0.1–1")).toBeInTheDocument();
    expect(screen.getByText("≥ 1")).toBeInTheDocument();
    expect(screen.getByText(/mm\/h/)).toBeInTheDocument();
  });

  it("alerts on an old image after a failed refresh, and shows errors with a retry", async () => {
    const p = props({ stale: true, error: "HTTP 503", nowMs: T + 25 * 60_000 });
    render(<RadarControls {...p} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/25 min ago/);
    expect(screen.getByText("HTTP 503")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(p.onReload).toHaveBeenCalledOnce();
  });

  it("shows loading, and credits Météo-France", () => {
    render(<RadarControls {...props({ loading: true, validTimeMs: null })} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Météo-France" })).toBeInTheDocument();
  });

  describe("animation", () => {
    it("has a toggle for the last hour", async () => {
      const p = props();
      render(<RadarControls {...p} />);
      await userEvent.click(screen.getByRole("checkbox", { name: /animate last hour/i }));
      expect(p.onToggleAnimate).toHaveBeenCalledOnce();
    });

    it("shows which frame is on the map", () => {
      render(<RadarControls {...props({ animate: true, frame: { validTimeMs: T - 30 * 60_000, position: 3 }, frameCount: 12 })} />);
      expect(screen.getByText("Frame 02:40 UTC · 3/12")).toBeInTheDocument();
      expect(screen.queryByText(/collect/i)).toBeNull();
    });

    it("says frames are still being collected", () => {
      render(<RadarControls {...props({ animate: true, frame: null, frameCount: 1 })} />);
      expect(screen.getByText(/1 of 12 frames/)).toBeInTheDocument();
      expect(screen.getByText(/while the radar is on/i)).toBeInTheDocument();
    });

    it("says nothing about frames while not animating", () => {
      render(<RadarControls {...props({ frameCount: 3 })} />);
      expect(screen.queryByText(/frame/i)).toBeNull();
    });
  });
});


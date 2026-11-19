import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SeaControls, type SeaControlsProps } from "../SeaControls";

function props(over: Partial<SeaControlsProps> = {}): SeaControlsProps {
  return {
    seamarks: false, onToggleSeamarks: vi.fn(), seamarkOpacity: 0.9, onSeamarkOpacityChange: vi.fn(),
    depthColours: false, onToggleDepthColours: vi.fn(), depthContours: false, onToggleDepthContours: vi.fn(),
    depthOpacity: 0.4, onDepthOpacityChange: vi.fn(),
    ...over,
  };
}

describe("SeaControls", () => {
  it("has three switches", async () => {
    const p = props();
    render(<SeaControls {...p} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /seamarks/i }));
    await userEvent.click(screen.getByRole("checkbox", { name: /depth colours/i }));
    await userEvent.click(screen.getByRole("checkbox", { name: /depth contours/i }));
    expect(p.onToggleSeamarks).toHaveBeenCalledOnce();
    expect(p.onToggleDepthColours).toHaveBeenCalledOnce();
    expect(p.onToggleDepthContours).toHaveBeenCalledOnce();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("shows the seamark slider and its zoom hint when seamarks are on", () => {
    const p = props({ seamarks: true });
    render(<SeaControls {...p} />);
    fireEvent.change(screen.getByRole("slider", { name: /seamark opacity/i }), { target: { value: "50" } });
    expect(p.onSeamarkOpacityChange).toHaveBeenCalledWith(0.5);
    expect(screen.getByText(/zoom 9/i)).toBeInTheDocument();
  });

  it("has one depth slider for colours and contours", () => {
    const p = props({ depthContours: true });
    render(<SeaControls {...p} />);
    fireEvent.change(screen.getByRole("slider", { name: /depth opacity/i }), { target: { value: "30" } });
    expect(p.onDepthOpacityChange).toHaveBeenCalledWith(0.3);
  });

  it("shows the depth legend only with the colours on", () => {
    const { rerender } = render(<SeaControls {...props({ depthContours: true })} />);
    expect(screen.queryByText(/depth, m/i)).toBeNull();
    rerender(<SeaControls {...props({ depthColours: true })} />);
    expect(screen.getByText(/depth, m/i)).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("credits both sources", () => {
    render(<SeaControls {...props({ seamarks: true, depthColours: true })} />);
    expect(screen.getByRole("link", { name: /openseamap/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /emodnet/i })).toBeInTheDocument();
  });
});

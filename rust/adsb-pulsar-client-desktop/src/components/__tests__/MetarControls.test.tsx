import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MetarControls, type MetarControlsProps } from "../MetarControls";

const NOW = 1_800_000_000_000;

function props(over: Partial<MetarControlsProps> = {}): MetarControlsProps {
  return {
    show: true,
    onToggle: vi.fn(),
    count: 12,
    fetchedAtMs: NOW - 3 * 60_000,
    nowMs: NOW,
    stale: false,
    loading: false,
    error: null,
    onReload: vi.fn(),
    opacity: 0.8,
    onOpacityChange: vi.fn(),
    showHoverInfo: true,
    onToggleHoverInfo: vi.fn(),
    categories: [
      { value: "VFR", label: "VFR", count: 9 },
      { value: "IFR", label: "IFR", count: 3 },
    ],
    hiddenCategories: [],
    onHiddenCategoriesChange: vi.fn(),
    transitionAltitudeFt: 5000,
    onTransitionAltitudeChange: vi.fn(),
    ...over,
  };
}

describe("MetarControls", () => {
  it("toggles the layer and shows nothing else while off", async () => {
    const p = props({ show: false });
    render(<MetarControls {...p} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /metar/i }));
    expect(p.onToggle).toHaveBeenCalledOnce();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("shows the station count and the age of the snapshot", () => {
    render(<MetarControls {...props()} />);
    expect(screen.getByText(/12 stations · updated 3 min ago/)).toBeInTheDocument();
  });

  it("alerts when a refresh failed and the reports shown are the previous ones", async () => {
    const p = props({ stale: true, error: "HTTP 503", fetchedAtMs: NOW - 40 * 60_000 });
    render(<MetarControls {...p} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/40 min ago/);
    expect(screen.getByText("HTTP 503")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(p.onReload).toHaveBeenCalledOnce();
  });

  it("has a refresh button even without errors", async () => {
    const p = props();
    render(<MetarControls {...p} />);
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(p.onReload).toHaveBeenCalledOnce();
  });

  it("shows loading", () => {
    render(<MetarControls {...props({ loading: true, fetchedAtMs: null, count: 0 })} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("has the opacity slider and the hover toggle", async () => {
    const p = props();
    render(<MetarControls {...p} />);
    fireEvent.change(screen.getByRole("slider", { name: /opacity/i }), { target: { value: "50" } });
    expect(p.onOpacityChange).toHaveBeenCalledWith(0.5);
    await userEvent.click(screen.getByRole("checkbox", { name: /hover/i }));
    expect(p.onToggleHoverInfo).toHaveBeenCalledOnce();
  });

  it("filters by flight category", async () => {
    const p = props({ hiddenCategories: ["IFR"] });
    render(<MetarControls {...p} />);
    const combo = screen.getByRole("button", { name: /flight categories/i });
    expect(combo).toHaveTextContent("1 of 2 categories");
    await userEvent.click(combo);
    await userEvent.click(screen.getByRole("checkbox", { name: "VFR (9)" }));
    expect(p.onHiddenCategoriesChange).toHaveBeenLastCalledWith(["IFR", "VFR"]);
  });

  it("sets the transition altitude used for the MSL correction", () => {
    const p = props();
    render(<MetarControls {...p} />);
    const input = screen.getByRole("spinbutton", { name: /transition altitude/i });
    expect(input).toHaveValue(5000);
    fireEvent.change(input, { target: { value: "7000" } });
    expect(p.onTransitionAltitudeChange).toHaveBeenCalledWith(7000);
  });

  it("ignores an empty or out-of-range transition altitude", () => {
    const p = props();
    render(<MetarControls {...p} />);
    const input = screen.getByRole("spinbutton", { name: /transition altitude/i });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "90000" } });
    expect(p.onTransitionAltitudeChange).not.toHaveBeenCalled();
  });

  it("credits AviationWeather.gov", () => {
    render(<MetarControls {...props()} />);
    expect(screen.getByText(/AviationWeather\.gov/)).toBeInTheDocument();
  });
});

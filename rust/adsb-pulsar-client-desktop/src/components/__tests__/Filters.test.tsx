import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FiltersPanel } from "../Filters";
import { DEFAULT_FILTERS } from "@/lib/types";

function renderFilters(overrides = {}) {
  const defaultProps = {
    filters: DEFAULT_FILTERS,
    onChange: vi.fn(),
    trackCount: 42,
    showHistory: false,
    onToggleHistory: vi.fn(),
    historyCount: 10,
    showDensity: false,
    onToggleDensity: vi.fn(),
    densityMetric: "positions" as const,
    onDensityMetricChange: vi.fn(),
    showSimulation: false,
    onToggleSimulation: vi.fn(),
    simulationCount: 0,
    ...overrides,
  };
  return { ...render(<FiltersPanel {...defaultProps} />), props: defaultProps };
}

describe("FiltersPanel", () => {
  it("renders with default filters", () => {
    renderFilters();
    expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
    expect(screen.getByText("Filters")).toBeInTheDocument();
  });

  it("callsign input calls onChange", async () => {
    const user = userEvent.setup();
    const { props } = renderFilters();
    const input = screen.getByPlaceholderText("Search...");
    await user.type(input, "A");
    expect(props.onChange).toHaveBeenCalled();
    // Check that the last call includes the typed character
    const lastCall = props.onChange.mock.calls[props.onChange.mock.calls.length - 1][0];
    expect(lastCall.callsign).toContain("A");
  });

  it("displays track count", () => {
    renderFilters({ trackCount: 42 });
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText(/aircraft/)).toBeInTheDocument();
  });

  it("demo flights toggle calls handler", async () => {
    const user = userEvent.setup();
    const onToggleSimulation = vi.fn();
    renderFilters({ onToggleSimulation });
    const checkbox = screen.getByText("Demo flights").closest("label")!.querySelector("input")!;
    await user.click(checkbox);
    expect(onToggleSimulation).toHaveBeenCalledTimes(1);
  });

  it("density toggle calls handler", async () => {
    const user = userEvent.setup();
    const onToggleDensity = vi.fn();
    renderFilters({ onToggleDensity });
    const checkbox = screen.getByText("H3 density heatmap").closest("label")!.querySelector("input")!;
    await user.click(checkbox);
    expect(onToggleDensity).toHaveBeenCalledTimes(1);
  });
});

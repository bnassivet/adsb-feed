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
    liveColorMode: "track" as const,
    onLiveColorModeChange: vi.fn(),
    historyColorMode: "track" as const,
    onHistoryColorModeChange: vi.fn(),
    importedCount: 0,
    showImported: false,
    onToggleImported: vi.fn(),
    onClearImported: vi.fn(),
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

  it("renders color coding section with live and history selects", () => {
    renderFilters();
    expect(screen.getByText("Color coding")).toBeInTheDocument();
    expect(screen.getByLabelText("Live tracks")).toBeInTheDocument();
    expect(screen.getByLabelText("History tracks")).toBeInTheDocument();
  });

  it("live color mode select calls handler on change", async () => {
    const user = userEvent.setup();
    const onLiveColorModeChange = vi.fn();
    renderFilters({ onLiveColorModeChange });
    const select = screen.getByLabelText("Live tracks");
    await user.selectOptions(select, "plot");
    expect(onLiveColorModeChange).toHaveBeenCalledWith("plot");
  });

  it("history color mode select calls handler on change", async () => {
    const user = userEvent.setup();
    const onHistoryColorModeChange = vi.fn();
    renderFilters({ onHistoryColorModeChange });
    const select = screen.getByLabelText("History tracks");
    await user.selectOptions(select, "plot");
    expect(onHistoryColorModeChange).toHaveBeenCalledWith("plot");
  });
});

describe("imported tracks section", () => {
  it("shows imported toggle when importedCount > 0", () => {
    renderFilters({ importedCount: 5, showImported: true });
    expect(screen.getByText(/Show imported/)).toBeInTheDocument();
    expect(screen.getByText("(5)")).toBeInTheDocument();
  });

  it("hides imported section when importedCount is 0", () => {
    renderFilters({ importedCount: 0 });
    expect(screen.queryByText(/Show imported/)).not.toBeInTheDocument();
  });

  it("calls onClearImported when clear button clicked", async () => {
    const user = userEvent.setup();
    const onClearImported = vi.fn();
    renderFilters({ importedCount: 3, showImported: true, onClearImported });
    await user.click(screen.getByText("Clear"));
    expect(onClearImported).toHaveBeenCalledOnce();
  });

  it("calls onToggleImported when checkbox toggled", async () => {
    const user = userEvent.setup();
    const onToggleImported = vi.fn();
    renderFilters({ importedCount: 2, showImported: false, onToggleImported });
    const checkbox = screen.getByText(/Show imported/).closest("label")!.querySelector("input")!;
    await user.click(checkbox);
    expect(onToggleImported).toHaveBeenCalledOnce();
  });
});

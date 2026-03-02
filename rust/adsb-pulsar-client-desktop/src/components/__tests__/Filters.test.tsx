import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FiltersPanel } from "../Filters";
import { DEFAULT_FILTERS } from "@/lib/types";

// HistoryBrowser has its own tests; mock it here to avoid Tauri/DuckDB side effects
vi.mock("@/components/HistoryBrowser", () => ({
  HistoryBrowser: () => null,
}));

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
    densityAltitudeMin: 0,
    densityAltitudeMax: 50000,
    onDensityAltitudeChange: vi.fn(),
    densityTooltipMode: "compact" as const,
    onDensityTooltipModeChange: vi.fn(),
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
    includeImportedInDensity: false,
    onToggleIncludeImportedInDensity: vi.fn(),
    onImportTracks: vi.fn(),
    showReceiver: true,
    onToggleReceiver: vi.fn(),
    hasReceiverLocation: true,
    ...overrides,
  };
  return { ...render(<FiltersPanel {...defaultProps} />), props: defaultProps };
}

describe("FiltersPanel", () => {
  it("renders with default filters", () => {
    renderFilters();
    expect(screen.getByPlaceholderText("Search... (comma-separated)")).toBeInTheDocument();
    expect(screen.getByText("Search & Filters")).toBeInTheDocument();
  });

  it("callsign input calls onChange", async () => {
    const user = userEvent.setup();
    const { props } = renderFilters();
    const input = screen.getByPlaceholderText("Search... (comma-separated)");
    await user.type(input, "A");
    expect(props.onChange).toHaveBeenCalled();
    // Check that the last call includes the typed character
    const lastCall = props.onChange.mock.calls[props.onChange.mock.calls.length - 1][0];
    expect(lastCall.callsign).toContain("A");
  });

  it("altitude filter renders dual-handle slider with formatted label", () => {
    renderFilters();
    // RangeSlider renders "0 ft – 50,000 ft" (em dash), not the old "Altitude: 0 - 50,000 ft"
    expect(screen.getByText("0 ft – 50,000 ft")).toBeInTheDocument();
  });

  it("speed filter renders dual-handle slider with formatted label", () => {
    renderFilters();
    // RangeSlider renders "0 kts – 600 kts" (em dash)
    expect(screen.getByText("0 kts – 600 kts")).toBeInTheDocument();
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

  it("density metric radio buttons include min/max altitude options", () => {
    renderFilters({ showDensity: true });
    expect(screen.getByText("Min altitude")).toBeInTheDocument();
    expect(screen.getByText("Max altitude")).toBeInTheDocument();
  });

  it("selecting min altitude metric calls handler", async () => {
    const user = userEvent.setup();
    const onDensityMetricChange = vi.fn();
    renderFilters({ showDensity: true, onDensityMetricChange });
    const radio = screen.getByText("Min altitude").closest("label")!.querySelector("input")!;
    await user.click(radio);
    expect(onDensityMetricChange).toHaveBeenCalledWith("altitude_min");
  });

  it("selecting max altitude metric calls handler", async () => {
    const user = userEvent.setup();
    const onDensityMetricChange = vi.fn();
    renderFilters({ showDensity: true, onDensityMetricChange });
    const radio = screen.getByText("Max altitude").closest("label")!.querySelector("input")!;
    await user.click(radio);
    expect(onDensityMetricChange).toHaveBeenCalledWith("altitude_max");
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

describe("include imported in filters (callsign/hex)", () => {
  it("hides 'Include Imported in filters' checkbox when no imported tracks", () => {
    renderFilters({ importedCount: 0 });
    expect(screen.queryByText(/Include Imported in filters/)).not.toBeInTheDocument();
  });

  it("shows 'Include Imported in filters' checkbox when imported tracks exist", () => {
    renderFilters({ importedCount: 3 });
    expect(screen.getByText(/Include Imported in filters/)).toBeInTheDocument();
  });

  it("checkbox is unchecked by default (includeImportedInFilter: false)", () => {
    renderFilters({ importedCount: 3, filters: { ...DEFAULT_FILTERS, includeImportedInFilter: false } });
    const label = screen.getByText(/Include Imported in filters/).closest("label")!;
    const checkbox = label.querySelector("input")!;
    expect(checkbox).not.toBeChecked();
  });

  it("checkbox is checked when includeImportedInFilter is true", () => {
    renderFilters({ importedCount: 3, filters: { ...DEFAULT_FILTERS, includeImportedInFilter: true } });
    const label = screen.getByText(/Include Imported in filters/).closest("label")!;
    const checkbox = label.querySelector("input")!;
    expect(checkbox).toBeChecked();
  });

  it("clicking checkbox calls onChange with includeImportedInFilter toggled to true", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters({
      importedCount: 3,
      filters: { ...DEFAULT_FILTERS, includeImportedInFilter: false },
      onChange,
    });
    const label = screen.getByText(/Include Imported in filters/).closest("label")!;
    await user.click(label.querySelector("input")!);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ includeImportedInFilter: true }),
    );
  });
});

describe("include imported in density", () => {
  it("shows checkbox when density is ON and imported tracks exist", () => {
    renderFilters({
      showDensity: true,
      importedCount: 5,
      includeImportedInDensity: false,
      onToggleIncludeImportedInDensity: vi.fn(),
    });
    expect(screen.getByText(/Include imported/)).toBeInTheDocument();
  });

  it("hides checkbox when density is OFF", () => {
    renderFilters({
      showDensity: false,
      importedCount: 5,
      includeImportedInDensity: false,
      onToggleIncludeImportedInDensity: vi.fn(),
    });
    expect(screen.queryByText(/Include imported/)).not.toBeInTheDocument();
  });

  it("hides checkbox when no imported tracks", () => {
    renderFilters({
      showDensity: true,
      importedCount: 0,
      includeImportedInDensity: false,
      onToggleIncludeImportedInDensity: vi.fn(),
    });
    expect(screen.queryByText(/Include imported/)).not.toBeInTheDocument();
  });

  it("calls toggle handler when checkbox clicked", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderFilters({
      showDensity: true,
      importedCount: 3,
      includeImportedInDensity: false,
      onToggleIncludeImportedInDensity: onToggle,
    });
    const checkbox = screen.getByText(/Include imported/).closest("label")!.querySelector("input")!;
    await user.click(checkbox);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe("density altitude range", () => {
  it("shows altitude range slider when density is ON", () => {
    renderFilters({ showDensity: true });
    // The density altitude slider shows "0 ft – 50,000 ft" label inside the density section
    // There are TWO altitude sliders: one in Search & Filters, one in Density Overlay
    const labels = screen.getAllByText("0 ft – 50,000 ft");
    expect(labels.length).toBe(2);
  });

  it("hides altitude range slider when density is OFF", () => {
    renderFilters({ showDensity: false });
    // Only one altitude slider (in Search & Filters)
    const labels = screen.getAllByText("0 ft – 50,000 ft");
    expect(labels.length).toBe(1);
  });

  it("shows custom range when min/max are non-default", () => {
    renderFilters({
      showDensity: true,
      densityAltitudeMin: 10000,
      densityAltitudeMax: 40000,
    });
    expect(screen.getByText("10,000 ft – 40,000 ft")).toBeInTheDocument();
  });
});

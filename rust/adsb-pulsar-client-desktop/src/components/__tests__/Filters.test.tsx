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
    historySliderMin: 0,
    historySliderMax: 24,
    historySliderRange: 24,
    onHistoryTimeChange: vi.fn(),
    showEvents: false,
    onToggleEvents: vi.fn(),
    eventsCount: 0,
    eventFilterMode: "all" as const,
    onEventFilterModeChange: vi.fn(),
    eventUpcomingDays: 7,
    onEventUpcomingDaysChange: vi.fn(),
    eventTimeRangeStart: Date.now(),
    eventTimeRangeEnd: Date.now() + 86400000,
    onEventTimeRangeChange: vi.fn(),
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

describe("history time range slider", () => {
  it("hides time slider when showHistory is false", () => {
    renderFilters({ showHistory: false, historySliderRange: 24 });
    // The slider would show "0h ago" or "now" labels — neither should appear in the history section
    expect(screen.queryByText("now")).not.toBeInTheDocument();
  });

  it("shows time slider when showHistory is true", () => {
    renderFilters({ showHistory: true, historySliderRange: 24, historySliderMin: 0, historySliderMax: 24 });
    // At full range (0, 24) the label is "24h ago – now"
    expect(screen.getByText("24h ago – now")).toBeInTheDocument();
  });

  it("shows correct label for narrowed range", () => {
    // sliderMin=6, sliderMax=18 → "18h ago – 6h ago"
    renderFilters({ showHistory: true, historySliderRange: 24, historySliderMin: 6, historySliderMax: 18 });
    expect(screen.getByText("18h ago – 6h ago")).toBeInTheDocument();
  });

  it("hides slider when historySliderRange is 0", () => {
    renderFilters({ showHistory: true, historySliderRange: 0 });
    expect(screen.queryByText("now")).not.toBeInTheDocument();
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

describe("events of interest toggle", () => {
  it("renders Show events toggle with count", () => {
    renderFilters({ showEvents: false, eventsCount: 5 });
    expect(screen.getByText(/Show events/)).toBeInTheDocument();
    expect(screen.getByText("(5)")).toBeInTheDocument();
  });

  it("calls onToggleEvents when checkbox clicked", async () => {
    const user = userEvent.setup();
    const onToggleEvents = vi.fn();
    renderFilters({ showEvents: false, onToggleEvents });
    const checkbox = screen.getByText(/Show events/).closest("label")!.querySelector("input")!;
    await user.click(checkbox);
    expect(onToggleEvents).toHaveBeenCalledOnce();
  });

  it("shows filter mode radios when showEvents is true", () => {
    renderFilters({ showEvents: true });
    expect(screen.getByText("All events")).toBeInTheDocument();
    expect(screen.getByText("Upcoming")).toBeInTheDocument();
    expect(screen.getByText("Time range")).toBeInTheDocument();
  });

  it("hides filter mode radios when showEvents is false", () => {
    renderFilters({ showEvents: false });
    expect(screen.queryByText("All events")).not.toBeInTheDocument();
    expect(screen.queryByText("Upcoming")).not.toBeInTheDocument();
  });

  it("calls onEventFilterModeChange when radio selected", async () => {
    const user = userEvent.setup();
    const onEventFilterModeChange = vi.fn();
    renderFilters({ showEvents: true, eventFilterMode: "all", onEventFilterModeChange });
    const radio = screen.getByText("Upcoming").closest("label")!.querySelector("input")!;
    await user.click(radio);
    expect(onEventFilterModeChange).toHaveBeenCalledWith("upcoming");
  });

  it("shows upcoming days input when mode is upcoming", () => {
    renderFilters({ showEvents: true, eventFilterMode: "upcoming", eventUpcomingDays: 7 });
    expect(screen.getByText("Next")).toBeInTheDocument();
    expect(screen.getByDisplayValue("7")).toBeInTheDocument();
    expect(screen.getByText("days")).toBeInTheDocument();
  });

  it("hides upcoming days input when mode is not upcoming", () => {
    renderFilters({ showEvents: true, eventFilterMode: "all" });
    expect(screen.queryByText("days")).not.toBeInTheDocument();
  });

  it("shows datetime inputs when mode is range", () => {
    renderFilters({ showEvents: true, eventFilterMode: "range" });
    const datetimeInputs = screen.getAllByDisplayValue(/.+/);
    const dtInputs = datetimeInputs.filter(el => el.getAttribute("type") === "datetime-local");
    expect(dtInputs.length).toBe(2);
  });

  it("hides datetime inputs when mode is not range", () => {
    renderFilters({ showEvents: true, eventFilterMode: "all" });
    const allInputs = document.querySelectorAll('input[type="datetime-local"]');
    expect(allInputs.length).toBe(0);
  });
});

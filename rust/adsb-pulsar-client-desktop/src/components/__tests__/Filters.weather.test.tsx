import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FiltersPanel } from "../Filters";
import type { WeatherControlsProps } from "../WeatherControls";
import { DEFAULT_FILTERS } from "@/lib/types";

// HistoryBrowser has its own tests; mock it here to avoid Tauri/DuckDB side effects
vi.mock("@/components/HistoryBrowser", () => ({
  HistoryBrowser: () => null,
}));

/** Every required FiltersPanel prop, and deliberately no `weather`. */
const baseProps = {
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
};

const weather: WeatherControlsProps = {
  show: false,
  onToggle: vi.fn(),
  level: 250,
  onLevelChange: vi.fn(),
  showBarbs: true,
  onToggleBarbs: vi.fn(),
  showParticles: false,
  onToggleParticles: vi.fn(),
  levels: [850, 250],
  availability: "available",
  validTimeMs: 0,
  stale: false,
  nowMs: 0,
  attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
};

describe("FiltersPanel weather section", () => {
  it("shows the weather controls when weather props are given", () => {
    render(<FiltersPanel {...baseProps} weather={weather} />);

    expect(screen.getByText("Weather")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /winds aloft/i })).toBeInTheDocument();
  });

  it("has no weather section without them", () => {
    // `weather` is optional: every existing caller of FiltersPanel keeps working.
    render(<FiltersPanel {...baseProps} />);

    expect(screen.queryByText("Weather")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /winds aloft/i })).not.toBeInTheDocument();
  });
});

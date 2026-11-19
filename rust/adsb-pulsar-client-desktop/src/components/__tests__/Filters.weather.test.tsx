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
  showPositions: true,
  onTogglePositions: vi.fn(),
  showLabels: false,
  onToggleLabels: vi.fn(),
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

describe("FiltersPanel airspace section", () => {
  const airspaces = {
    show: false,
    onToggle: vi.fn(),
    count: 0,
    status: { cycles: [], expired: false, errors: [] },
    loading: false,
    error: null,
    onReload: vi.fn(),
    opacity: 0.6,
    onOpacityChange: vi.fn(),
    showHoverInfo: true,
    onToggleHoverInfo: vi.fn(),
    types: [],
    hiddenTypes: [],
    onHiddenTypesChange: vi.fn(),
  };

  it("shows the airspace controls when airspace props are given", () => {
    render(<FiltersPanel {...baseProps} airspaces={airspaces} />);
    expect(screen.getByText("Airspaces")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /airspaces \(openaip\)/i })).toBeInTheDocument();
  });

  it("has no airspace section without them", () => {
    render(<FiltersPanel {...baseProps} />);
    expect(screen.queryByRole("checkbox", { name: /airspaces \(openaip\)/i })).not.toBeInTheDocument();
  });
});

describe("FiltersPanel METAR section", () => {
  const metar = {
    show: false, onToggle: vi.fn(), count: 0, fetchedAtMs: null, nowMs: 0, stale: false, loading: false,
    error: null, onReload: vi.fn(), opacity: 0.8, onOpacityChange: vi.fn(), showHoverInfo: true,
    onToggleHoverInfo: vi.fn(), categories: [], hiddenCategories: [], onHiddenCategoriesChange: vi.fn(),
    transitionAltitudeFt: 5000, onTransitionAltitudeChange: vi.fn(),
  };

  it("shows the METAR controls when METAR props are given", () => {
    render(<FiltersPanel {...baseProps} metar={metar} />);
    expect(screen.getByText("METAR")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /metar stations/i })).toBeInTheDocument();
  });

  it("has no METAR section without them", () => {
    render(<FiltersPanel {...baseProps} />);
    expect(screen.queryByRole("checkbox", { name: /metar stations/i })).not.toBeInTheDocument();
  });
});

describe("FiltersPanel radar section", () => {
  const radar = {
    show: false, onToggle: vi.fn(), validTimeMs: null, nowMs: 0, stale: false, loading: false, error: null,
    onReload: vi.fn(), opacity: 0.7, onOpacityChange: vi.fn(), scale: [],
    animate: false, onToggleAnimate: vi.fn(), frame: null, frameCount: 0,
  };
  it("shows the radar controls when radar props are given", () => {
    render(<FiltersPanel {...baseProps} radar={radar} />);
    expect(screen.getByRole("checkbox", { name: /rain radar/i })).toBeInTheDocument();
  });
  it("has no radar section without them", () => {
    render(<FiltersPanel {...baseProps} />);
    expect(screen.queryByRole("checkbox", { name: /rain radar/i })).not.toBeInTheDocument();
  });
});

describe("FiltersPanel sea section", () => {
  const sea = {
    seamarks: false, onToggleSeamarks: vi.fn(), seamarkOpacity: 0.9, onSeamarkOpacityChange: vi.fn(),
    depthColours: false, onToggleDepthColours: vi.fn(), depthContours: false, onToggleDepthContours: vi.fn(),
    depthOpacity: 0.35, onDepthOpacityChange: vi.fn(),
    seamarkHoverInfo: true, onToggleSeamarkHoverInfo: vi.fn(),
    seamarkDetails: { loading: false, count: 0, error: null, zoomedOut: true },
  };
  it("shows the sea controls when sea props are given", () => {
    render(<FiltersPanel {...baseProps} sea={sea} />);
    expect(screen.getByRole("checkbox", { name: /seamarks/i })).toBeInTheDocument();
  });
  it("has no sea section without them", () => {
    render(<FiltersPanel {...baseProps} />);
    expect(screen.queryByRole("checkbox", { name: /seamarks/i })).toBeNull();
  });
});


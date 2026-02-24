import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LeftPanel } from "@/components/LeftPanel";
import type { DensityMetric, AltitudeColorMode } from "@/lib/types";
import { DEFAULT_FILTERS } from "@/lib/types";

// HistoryBrowser has its own tests; mock it here to avoid Tauri/DuckDB side effects
vi.mock("@/components/HistoryBrowser", () => ({
  HistoryBrowser: () => null,
}));

// Minimal props required by FiltersPanel, forwarded through LeftPanel
const baseFilterProps = {
  filters: DEFAULT_FILTERS,
  onChange: vi.fn(),
  trackCount: 0,
  showHistory: false,
  onToggleHistory: vi.fn(),
  historyCount: 0,
  showDensity: false,
  onToggleDensity: vi.fn(),
  densityMetric: "positions" as DensityMetric,
  onDensityMetricChange: vi.fn(),
  showSimulation: false,
  onToggleSimulation: vi.fn(),
  simulationCount: 0,
  liveColorMode: "track" as AltitudeColorMode,
  onLiveColorModeChange: vi.fn(),
  historyColorMode: "track" as AltitudeColorMode,
  onHistoryColorModeChange: vi.fn(),
  importedCount: 0,
  showImported: false,
  onToggleImported: vi.fn(),
  onClearImported: vi.fn(),
  includeImportedInDensity: false,
  onToggleIncludeImportedInDensity: vi.fn(),
  onImportTracks: vi.fn(),
};

describe("LeftPanel", () => {
  it("renders collapsed strip with >> button when isOpen=false", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <LeftPanel isOpen={false} width={224} onToggle={onToggle} onWidthChange={vi.fn()} {...baseFilterProps} />
    );
    expect(screen.getByTitle("Show filters panel")).toBeInTheDocument();
    const strip = container.firstChild as HTMLElement;
    expect(strip.style.width).toBe("32px");
  });

  it("renders expanded panel with << button when isOpen=true", () => {
    render(
      <LeftPanel isOpen={true} width={224} onToggle={vi.fn()} onWidthChange={vi.fn()} {...baseFilterProps} />
    );
    expect(screen.getByTitle("Hide filters panel")).toBeInTheDocument();
  });

  it(">> button calls onToggle", () => {
    const onToggle = vi.fn();
    render(
      <LeftPanel isOpen={false} width={224} onToggle={onToggle} onWidthChange={vi.fn()} {...baseFilterProps} />
    );
    fireEvent.click(screen.getByTitle("Show filters panel"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("<< button calls onToggle", () => {
    const onToggle = vi.fn();
    render(
      <LeftPanel isOpen={true} width={224} onToggle={onToggle} onWidthChange={vi.fn()} {...baseFilterProps} />
    );
    fireEvent.click(screen.getByTitle("Hide filters panel"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("applies width as inline style when expanded", () => {
    const { container } = render(
      <LeftPanel isOpen={true} width={300} onToggle={vi.fn()} onWidthChange={vi.fn()} {...baseFilterProps} />
    );
    const panel = container.firstChild as HTMLElement;
    expect(panel.style.width).toBe("300px");
  });

  it("filters content is visible when expanded", () => {
    render(
      <LeftPanel isOpen={true} width={224} onToggle={vi.fn()} onWidthChange={vi.fn()} {...baseFilterProps} />
    );
    // FiltersPanel renders a "Search & Filters" section heading
    expect(screen.getByText("Search & Filters")).toBeInTheDocument();
  });

  it("drag on resize edge calls onWidthChange with clamped value", () => {
    const onWidthChange = vi.fn();
    const { container } = render(
      <LeftPanel isOpen={true} width={300} onToggle={vi.fn()} onWidthChange={onWidthChange} {...baseFilterProps} />
    );
    // The resize strip is the last child of the panel root
    const resizeEdge = container.firstChild!.lastChild as HTMLElement;
    fireEvent.mouseDown(resizeEdge, { clientX: 300 });
    fireEvent.mouseMove(document, { clientX: 350 }); // +50px drag right
    expect(onWidthChange).toHaveBeenCalledWith(350); // 300 + 50 = 350, within [180, 400]
  });

  it("drag clamps onWidthChange to MAX_PANEL_WIDTH=400", () => {
    const onWidthChange = vi.fn();
    const { container } = render(
      <LeftPanel isOpen={true} width={390} onToggle={vi.fn()} onWidthChange={onWidthChange} {...baseFilterProps} />
    );
    const resizeEdge = container.firstChild!.lastChild as HTMLElement;
    fireEvent.mouseDown(resizeEdge, { clientX: 390 });
    fireEvent.mouseMove(document, { clientX: 450 }); // would be 450, clamped to 400
    expect(onWidthChange).toHaveBeenCalledWith(400);
  });

  it("drag clamps onWidthChange to MIN_PANEL_WIDTH=180", () => {
    const onWidthChange = vi.fn();
    const { container } = render(
      <LeftPanel isOpen={true} width={200} onToggle={vi.fn()} onWidthChange={onWidthChange} {...baseFilterProps} />
    );
    const resizeEdge = container.firstChild!.lastChild as HTMLElement;
    fireEvent.mouseDown(resizeEdge, { clientX: 200 });
    fireEvent.mouseMove(document, { clientX: 100 }); // -100px drag left, would be 100, clamped to 180
    expect(onWidthChange).toHaveBeenCalledWith(180);
  });
});

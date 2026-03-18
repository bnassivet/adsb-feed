"use client";
import { useCallback, useRef } from "react";
import { FiltersPanel } from "@/components/Filters";
import type { Filters, DensityMetric, DensityTooltipMode, AltitudeColorMode } from "@/lib/types";

const MIN_PANEL_WIDTH = 180;
const MAX_PANEL_WIDTH = 400;
const COLLAPSED_WIDTH = 32;

interface LeftPanelProps {
  isOpen: boolean;
  width: number;
  onToggle: () => void;
  onWidthChange: (w: number) => void;
  // FiltersPanel props
  filters: Filters;
  onChange: (filters: Filters) => void;
  trackCount: number;
  showHistory: boolean;
  onToggleHistory: () => void;
  historyCount: number;
  showDensity: boolean;
  onToggleDensity: () => void;
  densityMetric: DensityMetric;
  onDensityMetricChange: (metric: DensityMetric) => void;
  densityAltitudeMin: number;
  densityAltitudeMax: number;
  onDensityAltitudeChange: (min: number, max: number) => void;
  densityTooltipMode: DensityTooltipMode;
  onDensityTooltipModeChange: (mode: DensityTooltipMode) => void;
  showSimulation: boolean;
  onToggleSimulation: () => void;
  simulationCount: number;
  liveColorMode: AltitudeColorMode;
  onLiveColorModeChange: (mode: AltitudeColorMode) => void;
  historyColorMode: AltitudeColorMode;
  onHistoryColorModeChange: (mode: AltitudeColorMode) => void;
  importedCount: number;
  showImported: boolean;
  onToggleImported: () => void;
  onClearImported: () => void;
  includeImportedInDensity: boolean;
  onToggleIncludeImportedInDensity: () => void;
  showReceiver: boolean;
  onToggleReceiver: () => void;
  hasReceiverLocation: boolean;
  historySliderMin: number;
  historySliderMax: number;
  historySliderRange: number;
  onHistoryTimeChange: (min: number, max: number) => void;
}

export function LeftPanel({ isOpen, width, onToggle, onWidthChange, ...filterProps }: LeftPanelProps) {
  return isOpen ? (
    <ExpandedPanel width={width} onToggle={onToggle} onWidthChange={onWidthChange} filterProps={filterProps} />
  ) : (
    <CollapsedStrip onToggle={onToggle} />
  );
}

function CollapsedStrip({ onToggle }: { onToggle: () => void }) {
  return (
    <div
      className="flex flex-col items-center justify-center bg-slate-900 border-r border-slate-700 flex-shrink-0"
      style={{ width: COLLAPSED_WIDTH }}
    >
      <button
        onClick={onToggle}
        title="Show filters panel"
        className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded transition text-xs font-mono"
      >
        {">>"}
      </button>
    </div>
  );
}

function ExpandedPanel({
  width,
  onToggle,
  onWidthChange,
  filterProps,
}: {
  width: number;
  onToggle: () => void;
  onWidthChange: (w: number) => void;
  filterProps: Omit<LeftPanelProps, "isOpen" | "width" | "onToggle" | "onWidthChange">;
}) {
  const lastX = useRef(0);
  const isDragging = useRef(false);
  const widthRef = useRef(width);
  widthRef.current = width; // keep ref in sync with latest prop during each render

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - lastX.current; // Moving right = expanding panel
      lastX.current = e.clientX;
      onWidthChange(Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, widthRef.current + delta)));
    },
    [onWidthChange],
  );

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseMove]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      lastX.current = e.clientX;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [handleMouseMove, handleMouseUp],
  );

  return (
    <div
      className="flex flex-row bg-slate-900 border-r border-slate-700 flex-shrink-0 overflow-hidden"
      style={{ width }}
    >
      {/* Panel content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-end px-3 py-2 border-b border-slate-700 flex-shrink-0">
          <button
            onClick={onToggle}
            title="Hide filters panel"
            className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded transition text-xs font-mono"
          >
            {"<<"}
          </button>
        </div>
        <FiltersPanel {...filterProps} />
      </div>

      {/* Right edge: draggable resize strip */}
      <div
        onMouseDown={handleMouseDown}
        className="w-1 cursor-col-resize bg-slate-700 hover:bg-blue-500 transition-colors flex-shrink-0"
      />
    </div>
  );
}

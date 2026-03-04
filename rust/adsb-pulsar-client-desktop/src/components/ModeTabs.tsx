"use client";
import type { ActiveMode } from "@/lib/types";

interface Props {
  activeMode: ActiveMode;
  onModeChange: (mode: ActiveMode) => void;
  liveCount: number;
  analysisCount: number;
  onClearAnalysis: () => void;
}

export function ModeTabs({ activeMode, onModeChange, liveCount, analysisCount, onClearAnalysis }: Props) {
  return (
    <div className="flex items-center gap-0.5 px-2 bg-slate-900 border-b border-slate-800" data-testid="mode-tabs">
      <button
        onClick={() => onModeChange("live")}
        data-testid="mode-tab-live"
        className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
          activeMode === "live"
            ? "text-blue-300 border-blue-400"
            : "text-slate-500 border-transparent hover:text-slate-300"
        }`}
      >
        Live ({liveCount})
      </button>
      <button
        onClick={() => onModeChange("analysis")}
        data-testid="mode-tab-analysis"
        className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
          activeMode === "analysis"
            ? "text-cyan-300 border-cyan-400"
            : "text-slate-500 border-transparent hover:text-slate-300"
        }`}
      >
        Analysis ({analysisCount})
      </button>
      {activeMode === "analysis" && analysisCount > 0 && (
        <button
          onClick={onClearAnalysis}
          data-testid="mode-tabs-clear-analysis"
          className="ml-auto px-2 py-0.5 text-[10px] text-slate-500 hover:text-red-400 hover:bg-red-900/20 rounded transition"
          title="Clear all analysis tracks"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

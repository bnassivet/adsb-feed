"use client";
import type { ActiveMode } from "@/lib/types";

interface Props {
  activeMode: ActiveMode;
  onModeChange: (mode: ActiveMode) => void;
  /** Aircraft shown, i.e. passing that mode's filters. */
  liveCount: number;
  analysisCount: number;
  /** All aircraft of the mode. When given, the tab reads `shown/total`. */
  liveTotal?: number;
  analysisTotal?: number;
  onClearAnalysis: () => void;
}

function countLabel(shown: number, total: number | undefined): string {
  return total === undefined ? `${shown}` : `${shown}/${total}`;
}

function countTitle(shown: number, total: number | undefined): string | undefined {
  return total === undefined ? undefined : `${shown} aircraft shown out of ${total} (filters)`;
}

export function ModeTabs({ activeMode, onModeChange, liveCount, analysisCount, liveTotal, analysisTotal, onClearAnalysis }: Props) {
  return (
    <div className="flex items-center gap-0.5 px-2 bg-slate-900 border-b border-slate-800" data-testid="mode-tabs">
      <button
        onClick={() => onModeChange("live")}
        data-testid="mode-tab-live"
        title={countTitle(liveCount, liveTotal)}
        className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
          activeMode === "live"
            ? "text-blue-300 border-blue-400"
            : "text-slate-500 border-transparent hover:text-slate-300"
        }`}
      >
        Live ({countLabel(liveCount, liveTotal)})
      </button>
      <button
        onClick={() => onModeChange("analysis")}
        data-testid="mode-tab-analysis"
        title={countTitle(analysisCount, analysisTotal)}
        className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
          activeMode === "analysis"
            ? "text-cyan-300 border-cyan-400"
            : "text-slate-500 border-transparent hover:text-slate-300"
        }`}
      >
        Analysis ({countLabel(analysisCount, analysisTotal)})
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

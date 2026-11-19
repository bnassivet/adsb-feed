"use client";

export interface ReliefControlsProps {
  show: boolean;
  onToggle: () => void;
  opacity: number;
  onOpacityChange: (opacity: number) => void;
}

/** The Filters panel's relief section: a hillshade over the base map. */
export function ReliefControls(p: ReliefControlsProps) {
  const percent = Math.round(p.opacity * 100);
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
        <input type="checkbox" checked={p.show} onChange={p.onToggle} className="accent-sky-500" />
        <span>Relief (hillshade)</span>
      </label>
      {p.show && (
        <div className="ml-5 flex flex-col gap-1 text-[11px] text-slate-500">
          <label className="flex items-center gap-2">
            <span>Opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={percent}
              onChange={(e) => p.onOpacityChange(Number(e.target.value) / 100)}
              aria-label="Relief opacity"
              className="flex-1 accent-sky-500"
            />
            <span className="w-8 text-right tabular-nums">{percent}%</span>
          </label>
          <span className="text-[10px] text-slate-600">
            Shading only: slopes darken the map, flat ground leaves it unchanged. Data:{" "}
            <a href="https://www.esri.com" target="_blank" rel="noreferrer" className="hover:underline">
              Esri
            </a>{" "}
            World Hillshade
          </span>
        </div>
      )}
    </div>
  );
}

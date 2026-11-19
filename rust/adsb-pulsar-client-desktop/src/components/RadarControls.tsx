"use client";
import { formatValidTime, legendLabels, type RadarBand } from "@/lib/radar";

export interface RadarControlsProps {
  show: boolean;
  onToggle: () => void;
  /** The time the image shows. */
  validTimeMs: number | null;
  /** Minute-resolution clock for the image's age. */
  nowMs: number;
  /** The last check failed: the image is the previous one. */
  stale: boolean;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  opacity: number;
  onOpacityChange: (opacity: number) => void;
  /** The colour scale the image was drawn with (from Rust). */
  scale: RadarBand[];
}

/** The Filters panel's rain radar section, laid out like METAR and Airspaces. */
export function RadarControls(p: RadarControlsProps) {
  const percent = Math.round(p.opacity * 100);
  const when = p.validTimeMs != null ? formatValidTime(p.validTimeMs, p.nowMs) : null;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
        <input type="checkbox" checked={p.show} onChange={p.onToggle} className="accent-sky-500" />
        <span>Rain radar (Météo-France)</span>
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
              aria-label="Radar opacity"
              className="flex-1 accent-sky-500"
            />
            <span className="w-8 text-right tabular-nums">{percent}%</span>
          </label>
          <div className="flex items-center justify-between gap-2">
            {p.loading ? <span>Loading…</span> : <span>{when ? `Image ${when}` : "No image"}</span>}
            {!p.loading && !p.error && (
              <button type="button" onClick={p.onReload} className="text-sky-400 hover:underline">
                Refresh
              </button>
            )}
          </div>
          {p.stale && when && (
            <p role="alert" className="text-amber-400">
              Refresh failed: the image is from {when.split(" · ")[1]}.
            </p>
          )}
          {p.error && (
            <>
              <p className="text-red-400 break-words">{p.error}</p>
              <button type="button" onClick={p.onReload} className="self-start text-sky-400 hover:underline">
                Retry
              </button>
            </>
          )}
          {p.scale.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <span>Rain rate, mm/h</span>
              <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                {legendLabels(p.scale).map((b) => (
                  <span key={b.label} className="flex items-center gap-1">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: b.color }} />
                    <span>{b.label}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          <span className="text-[10px] text-slate-600">
            Radar:{" "}
            <a href="https://meteofrance.com" target="_blank" rel="noreferrer" className="hover:underline">
              Météo-France
            </a>{" "}
            (Etalab 2.0)
          </span>
        </div>
      )}
    </div>
  );
}

"use client";
import { describeHere, type WhatIsHereResult } from "@/lib/terrain";

export interface WhatIsHereProps {
  /** Screen position, like the context menu it comes from. */
  x: number;
  y: number;
  lat: number;
  lng: number;
  /** Null while loading. */
  result: WhatIsHereResult | null;
  /** The command itself failed. */
  error: string | null;
  onClose: () => void;
}

/** "What's here?": ground height and sea depth at a right-clicked point. */
export function WhatIsHere({ x, y, lat, lng, result, error, onClose }: WhatIsHereProps) {
  return (
    <div
      role="dialog"
      aria-label="What's here"
      className="fixed z-[1300] w-60 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 shadow-lg"
      style={{ left: x, top: y }}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold">What&apos;s here?</span>
        <button type="button" aria-label="Close" onClick={onClose} className="text-slate-500 hover:text-slate-200">
          ×
        </button>
      </div>
      {error ? (
        <p className="text-red-400 break-words">{error}</p>
      ) : result ? (
        describeHere(result).map((line) => (
          <p key={line} className={/unavailable/.test(line) ? "text-amber-400 break-words" : undefined}>
            {line}
          </p>
        ))
      ) : (
        <p className="text-slate-500">Loading… (a new area downloads one terrain tile)</p>
      )}
      <div className="mt-1 border-t border-slate-800 pt-1 text-[10px] text-slate-600">
        <div className="tabular-nums">
          {lat.toFixed(5)}, {lng.toFixed(5)}
        </div>
        Ground: Terrarium (Mapzen, AWS). Depth: EMODnet Bathymetry.
      </div>
    </div>
  );
}

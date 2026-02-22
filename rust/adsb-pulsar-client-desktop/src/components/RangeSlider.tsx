"use client";

interface RangeSliderProps {
  min: number;
  max: number;
  step: number;
  valueMin: number;
  valueMax: number;
  onChange: (min: number, max: number) => void;
  formatLabel: (v: number) => string;
}

export function RangeSlider({
  min,
  max,
  step,
  valueMin,
  valueMax,
  onChange,
  formatLabel,
}: RangeSliderProps) {
  const range = max - min;
  const leftPct = ((valueMin - min) / range) * 100;
  const widthPct = ((valueMax - valueMin) / range) * 100;

  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1">
        {formatLabel(valueMin)} – {formatLabel(valueMax)}
      </label>
      {/* Track container — height matches thumb size */}
      <div className="relative h-4 flex items-center">
        {/* Grey track background */}
        <div className="absolute left-0 right-0 h-1 bg-slate-600 rounded" />
        {/* Blue fill between thumbs */}
        <div
          className="absolute h-1 bg-blue-500 rounded"
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        />
        {/* Min range input.
            pointer-events-none on the element prevents the full-width rectangle from
            swallowing events. pointer-events-auto on the thumb means only the circle
            is clickable. z-index is raised when handles are adjacent so the min thumb
            stays draggable leftward even when both thumbs are at the same position. */}
        <input
          type="range"
          aria-label="minimum"
          min={min}
          max={max}
          step={step}
          value={valueMin}
          onChange={(e) => {
            const v = Math.min(Number(e.target.value), valueMax - step);
            onChange(v, valueMax);
          }}
          style={{ zIndex: valueMin >= valueMax - step ? 4 : 3 }}
          className={[
            "absolute w-full h-full appearance-none bg-transparent pointer-events-none",
            // Thumb — only the circle responds to clicks/drags
            "[&::-webkit-slider-thumb]:appearance-none",
            "[&::-webkit-slider-thumb]:pointer-events-auto",
            "[&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5",
            "[&::-webkit-slider-thumb]:rounded-full",
            "[&::-webkit-slider-thumb]:bg-blue-400",
            "[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-slate-900",
            "[&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:active:cursor-grabbing",
            // Firefox thumb
            "[&::-moz-range-thumb]:pointer-events-auto",
            "[&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5",
            "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-none",
            "[&::-moz-range-thumb]:bg-blue-400",
            // Hide native track
            "[&::-webkit-slider-runnable-track]:bg-transparent",
            "[&::-moz-range-track]:bg-transparent",
          ].join(" ")}
        />
        {/* Max range input — same pointer-events treatment; default z-index below min when adjacent */}
        <input
          type="range"
          aria-label="maximum"
          min={min}
          max={max}
          step={step}
          value={valueMax}
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), valueMin + step);
            onChange(valueMin, v);
          }}
          style={{ zIndex: 3 }}
          className={[
            "absolute w-full h-full appearance-none bg-transparent pointer-events-none",
            "[&::-webkit-slider-thumb]:appearance-none",
            "[&::-webkit-slider-thumb]:pointer-events-auto",
            "[&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5",
            "[&::-webkit-slider-thumb]:rounded-full",
            "[&::-webkit-slider-thumb]:bg-blue-400",
            "[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-slate-900",
            "[&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:active:cursor-grabbing",
            "[&::-moz-range-thumb]:pointer-events-auto",
            "[&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5",
            "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-none",
            "[&::-moz-range-thumb]:bg-blue-400",
            "[&::-webkit-slider-runnable-track]:bg-transparent",
            "[&::-moz-range-track]:bg-transparent",
          ].join(" ")}
        />
      </div>
    </div>
  );
}

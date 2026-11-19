"use client";
import { useRef } from "react";
import { formatOffset, formatUtcTime, frameOffsetMinutes, type RadarImage } from "@/lib/radar";

/** Wheel travel per frame: a trackpad sends many small deltas, a mouse a few big ones. */
export const WHEEL_STEP_PX = 40;

/** A 4 px track with a small round thumb: the native slider is ~16 px tall in WebKit. */
const THIN_RANGE = [
  "h-1 flex-1 cursor-pointer appearance-none rounded-full bg-slate-600",
  "[&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none",
  "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-400",
  "[&::-moz-range-thumb]:h-2.5 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:rounded-full",
  "[&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-sky-400",
].join(" ");

export interface RadarTimelineProps {
  /** Oldest first. */
  frames: RadarImage[];
  index: number;
  playing: boolean;
  /** Show frame `i` (and pause). */
  onSeek: (i: number) => void;
  onTogglePlay: () => void;
}

/**
 * The radar animation's time bar, over the map: how far back the shown frame
 * is, a slider over the frames, play/pause. Scrolling over it steps a frame
 * per notch: down or right is later, up or left earlier.
 */
export function RadarTimeline({ frames, index, playing, onSeek, onTogglePlay }: RadarTimelineProps) {
  const wheel = useRef(0);
  const last = frames.length - 1;
  const shown = frames[Math.min(index, last)];
  if (!shown) return null;

  const onWheel = (e: React.WheelEvent) => {
    wheel.current += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const steps = Math.trunc(wheel.current / WHEEL_STEP_PX);
    if (steps === 0) return;
    wheel.current -= steps * WHEEL_STEP_PX;
    const target = Math.min(Math.max(index + steps, 0), last);
    if (target !== index) onSeek(target);
  };

  return (
    <div
      role="group"
      aria-label="Radar timeline"
      onWheel={onWheel}
      className="pointer-events-auto flex w-80 max-w-[calc(100%-2rem)] items-center gap-2 rounded-full bg-slate-900/85 px-2.5 py-0.5 text-[10px] leading-4 text-slate-300 shadow-lg backdrop-blur-sm"
    >
      <button
        type="button"
        onClick={onTogglePlay}
        aria-label={playing ? "Pause radar animation" : "Play radar animation"}
        className="w-3 text-[9px] text-sky-400 hover:text-sky-300"
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <input
        type="range"
        min={0}
        max={last}
        step={1}
        value={Math.min(index, last)}
        onChange={(e) => onSeek(Number(e.target.value))}
        aria-label="Radar time"
        className={THIN_RANGE}
      />
      <span className="shrink-0 tabular-nums text-sky-300">
        {formatOffset(frameOffsetMinutes(frames, index))} · {formatUtcTime(shown.validTimeMs)}
      </span>
    </div>
  );
}

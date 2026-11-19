"use client";
import { useRef } from "react";
import { formatOffset, formatUtcTime, frameOffsetMinutes, type RadarImage } from "@/lib/radar";

/** Wheel travel per frame: a trackpad sends many small deltas, a mouse a few big ones. */
export const WHEEL_STEP_PX = 40;

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
      className="pointer-events-auto flex w-80 max-w-[calc(100%-2rem)] flex-col gap-0.5 rounded-md bg-slate-900/85 px-3 py-1.5 text-[11px] text-slate-300 shadow-lg backdrop-blur-sm"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onTogglePlay}
          aria-label={playing ? "Pause radar animation" : "Play radar animation"}
          className="w-5 text-sky-400 hover:text-sky-300"
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
          className="flex-1 accent-sky-500"
        />
      </div>
      <div className="flex items-center justify-between gap-2 pl-7 tabular-nums">
        <span className="text-slate-500">{formatOffset(frameOffsetMinutes(frames, 0))}</span>
        <span className="text-sky-300">
          {formatOffset(frameOffsetMinutes(frames, index))} · {formatUtcTime(shown.validTimeMs)}
        </span>
        <span className="text-slate-500">latest</span>
      </div>
    </div>
  );
}

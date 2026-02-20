"use client";
import { useCallback, useRef } from "react";
import type { AircraftTrack } from "@/lib/types";
import {
  verticalTendency,
  formatVerticalRate,
  altitudeHistory,
  altitudeSparklinePoints,
  altitudeRange,
  formatTrackTime,
} from "@/lib/aircraft-details";
import { timeAgo } from "@/lib/format";

const MIN_PANEL_WIDTH = 200;
const MAX_PANEL_WIDTH = 480;
const COLLAPSED_WIDTH = 32;

/** Labels for special squawk codes. */
const SQUAWK_LABELS: Record<string, string> = {
  "7700": "EMERGENCY",
  "7600": "RADIO FAILURE",
  "7500": "HIJACK",
};

interface Props {
  track: AircraftTrack | null;
  isOpen: boolean;
  width: number;
  onToggle: () => void;
  onWidthChange: (w: number) => void;
}

export function AircraftDetailsPanel({
  track,
  isOpen,
  width,
  onToggle,
  onWidthChange,
}: Props) {
  if (track === null) return null;

  return isOpen ? (
    <ExpandedPanel
      track={track}
      width={width}
      onToggle={onToggle}
      onWidthChange={onWidthChange}
    />
  ) : (
    <CollapsedStrip onToggle={onToggle} />
  );
}

function CollapsedStrip({ onToggle }: { onToggle: () => void }) {
  return (
    <div
      className="flex flex-col items-center justify-center bg-slate-900 border-l border-slate-700 flex-shrink-0"
      style={{ width: COLLAPSED_WIDTH }}
    >
      <button
        onClick={onToggle}
        title="Unfold panel"
        className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded transition text-xs font-mono"
      >
        {">>"}
      </button>
    </div>
  );
}

function ExpandedPanel({
  track,
  width,
  onToggle,
  onWidthChange,
}: {
  track: AircraftTrack;
  width: number;
  onToggle: () => void;
  onWidthChange: (w: number) => void;
}) {
  const lastX = useRef(0);
  const isDragging = useRef(false);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = lastX.current - e.clientX; // Moving left = expanding panel
      lastX.current = e.clientX;
      onWidthChange(Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, width + delta)));
    },
    [width, onWidthChange],
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

  const tendency = verticalTendency(track.vertical_rate);
  const altHistory = altitudeHistory(track.positions);
  const recentAlt = altHistory.slice(-100);
  const sparklinePoints = altitudeSparklinePoints(recentAlt, 120, 40);
  const altBounds = altitudeRange(recentAlt);
  const squawkLabel = track.squawk ? SQUAWK_LABELS[track.squawk] : undefined;

  return (
    <div
      className="flex flex-row bg-slate-900 border-l border-slate-700 flex-shrink-0 overflow-hidden"
      style={{ width }}
    >
      {/* Left edge: draggable resize strip */}
      <div
        onMouseDown={handleMouseDown}
        className="w-1 cursor-col-resize bg-slate-700 hover:bg-blue-500 transition-colors flex-shrink-0"
      />

      {/* Panel content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 flex-shrink-0">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
            Aircraft Details
          </span>
          <button
            onClick={onToggle}
            title="Fold panel"
            className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded transition text-xs font-mono"
          >
            {"<<"}
          </button>
        </div>

        {/* Identity */}
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="font-mono text-base font-bold text-slate-100 tracking-widest">
            {track.hex_ident}
          </div>
          <div className="text-sm text-slate-300 mt-0.5">
            {track.callsign ?? "—"}
          </div>
        </div>

        {/* Altitude, Speed, Heading */}
        <div className="px-3 py-2 border-b border-slate-800 space-y-1">
          <Row label="Altitude">
            {track.altitude !== null ? (
              <span>{track.altitude.toLocaleString("en-US")} ft</span>
            ) : (
              <span className="text-slate-500">—</span>
            )}
            {track.is_on_ground && (
              <span className="ml-2 px-1 py-0.5 text-xs bg-amber-800/60 text-amber-300 rounded">
                GND
              </span>
            )}
          </Row>
          <Row label="Speed">
            {track.ground_speed !== null ? (
              <span>{track.ground_speed} kts</span>
            ) : (
              <span className="text-slate-500">—</span>
            )}
          </Row>
          <Row label="Heading">
            {track.track !== null ? (
              <span>{track.track}°</span>
            ) : (
              <span className="text-slate-500">—</span>
            )}
          </Row>
        </div>

        {/* Vertical tendency */}
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <TendencyArrow tendency={tendency} />
            <span
              className={`text-sm ${
                tendency === "climbing"
                  ? "text-green-400"
                  : tendency === "descending"
                    ? "text-red-400"
                    : "text-slate-400"
              }`}
            >
              {formatVerticalRate(track.vertical_rate)}
            </span>
          </div>
          {sparklinePoints && (
            <div className="mt-2">
              {/* Chart area: y-axis labels + SVG */}
              <div className="flex gap-1">
                {/* Y-axis labels: max at top, min at bottom */}
                <div className="flex flex-col justify-between text-right" style={{ width: 36 }}>
                  <span
                    data-testid="sparkline-alt-max"
                    className="text-slate-500 leading-none"
                    style={{ fontSize: 9 }}
                  >
                    {altBounds!.max.toLocaleString("en-US")}
                  </span>
                  <span
                    data-testid="sparkline-alt-min"
                    className="text-slate-500 leading-none"
                    style={{ fontSize: 9 }}
                  >
                    {altBounds!.min.toLocaleString("en-US")}
                  </span>
                </div>
                {/* Sparkline SVG */}
                <svg
                  width="120"
                  height="40"
                  viewBox="0 0 120 40"
                  className="overflow-visible flex-shrink-0"
                >
                  <polyline
                    points={sparklinePoints}
                    fill="none"
                    stroke={
                      tendency === "climbing"
                        ? "#4ade80"
                        : tendency === "descending"
                          ? "#f87171"
                          : "#94a3b8"
                    }
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              {/* X-axis labels: start time left, last update right */}
              <div className="flex justify-between mt-0.5" style={{ paddingLeft: 40 }}>
                <span
                  data-testid="sparkline-time-start"
                  className="text-slate-500 leading-none"
                  style={{ fontSize: 9 }}
                >
                  {formatTrackTime(track.first_seen)}
                </span>
                <span
                  data-testid="sparkline-time-end"
                  className="text-slate-500 leading-none"
                  style={{ fontSize: 9 }}
                >
                  {formatTrackTime(track.last_seen)}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Squawk */}
        <div className="px-3 py-2 border-b border-slate-800">
          <Row label="Squawk">
            <span className="font-mono">{track.squawk ?? "—"}</span>
            {squawkLabel && (
              <span className="ml-2 px-1 py-0.5 text-xs bg-red-800/60 text-red-300 rounded font-semibold">
                {squawkLabel}
              </span>
            )}
          </Row>
        </div>

        {/* Messages + Last Seen */}
        <div className="px-3 py-2 space-y-1">
          <Row label="Messages">
            <span>{track.message_count.toLocaleString("en-US")}</span>
          </Row>
          <Row label="Last seen">
            <span className="text-slate-400">{timeAgo(track.last_seen)}</span>
          </Row>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-500 text-xs">{label}</span>
      <span className="text-slate-200 flex items-center">{children}</span>
    </div>
  );
}

function TendencyArrow({ tendency }: { tendency: "climbing" | "descending" | "level" }) {
  if (tendency === "climbing") {
    return (
      <span
        data-testid="tendency-climbing"
        className="text-green-400 text-base leading-none"
      >
        ▲
      </span>
    );
  }
  if (tendency === "descending") {
    return (
      <span
        data-testid="tendency-descending"
        className="text-red-400 text-base leading-none"
      >
        ▼
      </span>
    );
  }
  return (
    <span
      data-testid="tendency-level"
      className="text-slate-400 text-base leading-none"
    >
      →
    </span>
  );
}

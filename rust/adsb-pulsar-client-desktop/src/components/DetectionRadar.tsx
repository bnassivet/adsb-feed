"use client";
import { useMemo } from "react";
import type { DetectionRangeSector } from "@/lib/types";
import type { RadarMode } from "@/lib/detection-radar";
import {
  computeMaxRange,
  buildRadarPoints,
  buildRadarPath,
  buildSectorWedges,
  buildDistanceRings,
  buildCardinalLabels,
} from "@/lib/detection-radar";

interface Props {
  sectors: DetectionRangeSector[];
  mode: RadarMode;
}

const CONFIG = { size: 300, padding: 24 };
const SECTOR_ANGLE_DEG = 10;

export function DetectionRadar({ sectors, mode }: Props) {
  const maxRange = useMemo(() => computeMaxRange(sectors), [sectors]);
  const rings = useMemo(() => buildDistanceRings(maxRange, CONFIG), [maxRange]);
  const cardinals = useMemo(() => buildCardinalLabels(CONFIG), []);

  // Polygon mode data
  const polygonPath = useMemo(() => {
    if (mode !== "polygon") return "";
    return buildRadarPath(buildRadarPoints(sectors, CONFIG));
  }, [sectors, mode]);

  // Polar mode data
  const wedges = useMemo(() => {
    if (mode !== "polar") return [];
    return buildSectorWedges(sectors, CONFIG);
  }, [sectors, mode]);

  const center = CONFIG.size / 2;
  const maxRadius = center - CONFIG.padding;

  // Sector grid lines at every 10° boundary (polar mode only)
  const sectorLines = useMemo(() => {
    if (mode !== "polar") return [];
    const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (let deg = 0; deg < 360; deg += SECTOR_ANGLE_DEG) {
      const rad = (deg * Math.PI) / 180;
      lines.push({
        x1: center,
        y1: center,
        x2: center + maxRadius * Math.sin(rad),
        y2: center - maxRadius * Math.cos(rad),
      });
    }
    return lines;
  }, [mode, center, maxRadius]);

  return (
    <div data-testid="detection-radar">
      <svg
        viewBox={`0 0 ${CONFIG.size} ${CONFIG.size}`}
        className="w-full"
        role="img"
        aria-label="Detection range radar chart"
      >
        {/* Concentric distance rings */}
        {rings.map((ring, i) => (
          <g key={i}>
            <circle
              cx={center}
              cy={center}
              r={ring.radius}
              fill="none"
              stroke="#334155"
              strokeWidth={0.5}
            />
            <text
              x={center + 2}
              y={center - ring.radius + 10}
              fill="#475569"
              fontSize={8}
              data-testid="ring-label"
            >
              {ring.label}
            </text>
          </g>
        ))}

        {/* 10° sector grid lines (polar mode) */}
        {sectorLines.map((l, i) => (
          <line
            key={i}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            stroke="#1e293b"
            strokeWidth={0.3}
          />
        ))}

        {/* Crosshair lines (N-S, E-W) */}
        <line
          x1={center}
          y1={CONFIG.padding}
          x2={center}
          y2={CONFIG.size - CONFIG.padding}
          stroke="#334155"
          strokeWidth={0.5}
        />
        <line
          x1={CONFIG.padding}
          y1={center}
          x2={CONFIG.size - CONFIG.padding}
          y2={center}
          stroke="#334155"
          strokeWidth={0.5}
        />

        {/* Polygon mode: single filled polygon */}
        {mode === "polygon" && polygonPath && (
          <path
            d={polygonPath}
            fill="#06b6d4"
            fillOpacity={0.3}
            stroke="#06b6d4"
            strokeWidth={1.5}
            data-testid="radar-polygon"
          />
        )}

        {/* Polar mode: individual sector wedges */}
        {mode === "polar" &&
          wedges.map((w) => (
            <path
              key={w.bearingDeg}
              d={w.path}
              fill="#06b6d4"
              fillOpacity={0.35}
              stroke="#06b6d4"
              strokeWidth={0.5}
              data-testid="radar-wedge"
            />
          ))}

        {/* Cardinal direction labels */}
        {cardinals.map((c) => (
          <text
            key={c.label}
            x={c.x}
            y={c.y}
            fill="#64748b"
            fontSize={11}
            fontWeight={600}
            textAnchor="middle"
            dominantBaseline="central"
            data-testid="cardinal-label"
          >
            {c.label}
          </text>
        ))}
      </svg>

      {/* Max range label */}
      <div className="text-center text-[10px] text-slate-500 mt-0.5">
        Max range: {Math.round(maxRange)} NM
      </div>
    </div>
  );
}

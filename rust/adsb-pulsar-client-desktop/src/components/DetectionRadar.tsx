"use client";
import { useMemo } from "react";
import type { DetectionRangeSector } from "@/lib/types";
import {
  computeMaxRange,
  buildRadarPoints,
  buildRadarPath,
  buildDistanceRings,
  buildCardinalLabels,
} from "@/lib/detection-radar";

interface Props {
  sectors: DetectionRangeSector[];
}

const CONFIG = { size: 300, padding: 24 };

export function DetectionRadar({ sectors }: Props) {
  const maxRange = useMemo(() => computeMaxRange(sectors), [sectors]);
  const points = useMemo(() => buildRadarPoints(sectors, CONFIG), [sectors]);
  const path = useMemo(() => buildRadarPath(points), [points]);
  const rings = useMemo(() => buildDistanceRings(maxRange, CONFIG), [maxRange]);
  const cardinals = useMemo(() => buildCardinalLabels(CONFIG), []);

  const center = CONFIG.size / 2;

  return (
    <div data-testid="detection-radar">
      <div className="text-[10px] text-slate-500 uppercase mb-1">Detection Range</div>
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

        {/* Filled radar polygon */}
        {path && (
          <path
            d={path}
            fill="#06b6d4"
            fillOpacity={0.3}
            stroke="#06b6d4"
            strokeWidth={1.5}
            data-testid="radar-polygon"
          />
        )}

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

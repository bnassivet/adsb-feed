"use client";
import { ageMinutes, formatAge, isOld, metarColor, type Metar } from "@/lib/metar";

/** The station under the cursor: decoded fields first, then the raw report. */
export function MetarInfo({ metar, nowMs }: { metar: Metar | null; nowMs: number }) {
  if (!metar) return null;
  const age = ageMinutes(metar.obsTimeMs, nowMs);
  const temp = metar.tempC != null ? `${metar.tempC}${metar.dewpC != null ? ` / ${metar.dewpC}` : ""} °C` : null;
  const lines = [
    metar.wind && `Wind ${metar.wind}`,
    metar.visibility && `Vis ${metar.visibility}`,
    metar.clouds,
    metar.weather,
    temp,
    metar.qnhHpa != null && `QNH ${Math.round(metar.qnhHpa)} hPa`,
  ].filter(Boolean) as string[];
  return (
    <div className="max-w-xs pointer-events-none rounded bg-slate-900/85 px-2 py-1.5 text-[11px] leading-tight text-slate-200 shadow">
      <div className="flex items-center gap-1.5">
        <span className="font-semibold">{metar.id}</span>
        <span className="rounded px-1 text-[9px] font-bold text-slate-900" style={{ background: metarColor(metar.category) }}>
          {metar.category ?? "?"}
        </span>
        {metar.speci && <span className="text-[9px] text-amber-300">SPECI</span>}
        <span className="text-slate-400">{formatAge(age)}</span>
      </div>
      <div className="text-slate-400">{metar.name}</div>
      {isOld(age) && <div className="text-amber-400">Old report</div>}
      <div className="mt-0.5">{lines.join(" · ")}</div>
      <div className="mt-1 font-mono text-[10px] text-slate-400 break-words">{metar.raw}</div>
    </div>
  );
}

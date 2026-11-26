"use client";
import { useEffect, useState } from "react";
import { Bar, BarChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getOpenSkyCredits } from "@/lib/commands";
import { hourlyAllowance, type CreditsReport } from "@/lib/opensky";

/** Refresh period while the panel is open. Reading credits costs none. */
export const CREDITS_REFRESH_MS = 60_000;

const STATES_COLOR = "#a78bfa"; // violet-400, the OpenSky layer's colour
const TRACKS_COLOR = "#f472b6"; // pink-400

/**
 * OpenSky credits spent per hour over the last 24 h, per bucket, with the
 * hourly average the budget allows as a reference line.
 *
 * Always the last 24 h, whatever range the DB History panel is showing:
 * credits are a property of the account, not of recorded data.
 */
/**
 * Credits used over the 24 h against the limit, and what OpenSky itself says
 * is left when it said: "190 / 8,000 · tracks 4 · 7,412 left at OpenSky".
 * OpenSky's count covers the whole account, so it can be lower than ours.
 */
export function creditsTotal(report: CreditsReport): string {
  const states = report.hours.reduce((n, h) => n + h.states, 0);
  const tracks = report.hours.reduce((n, h) => n + h.tracks, 0);
  const left = report.states_remaining;
  return (
    `${states.toLocaleString("en-US")} / ${report.daily_limit.toLocaleString("en-US")}` +
    (tracks > 0 ? ` · tracks ${tracks}` : "") +
    (left != null ? ` · ${left.toLocaleString("en-US")} left at OpenSky` : "")
  );
}

export function OpenSkyCreditsView({ report, header = true }: { report: CreditsReport; header?: boolean }) {
  const data = report.hours.map((h) => ({
    hour: new Date(h.hour_start_ms).getHours().toString().padStart(2, "0"),
    states: h.states,
    tracks: h.tracks,
  }));
  return (
    <div data-testid="opensky-credits-chart">
      {header && (
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] text-slate-500 uppercase">OpenSky credits — last 24 h</div>
          <div className="text-[10px] text-slate-400 font-mono" data-testid="opensky-credits-total">
            {creditsTotal(report)}
          </div>
        </div>
      )}
      <ResponsiveContainer width="100%" height={90}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <XAxis dataKey="hour" tick={{ fontSize: 9, fill: "#64748b" }} interval={3} />
          <YAxis tick={{ fontSize: 9, fill: "#64748b" }} allowDecimals={false} />
          <Tooltip
            contentStyle={{ background: "#1e293b", border: "1px solid #334155", fontSize: 11 }}
            labelFormatter={(h) => `${h}:00`}
          />
          <ReferenceLine
            y={hourlyAllowance(report.daily_limit)}
            stroke="#64748b"
            strokeDasharray="3 3"
            ifOverflow="extendDomain"
          />
          <Bar dataKey="states" name="/states" stackId="c" fill={STATES_COLOR} />
          <Bar dataKey="tracks" name="/tracks" stackId="c" fill={TRACKS_COLOR} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * The DB History panel's OpenSky Credits section, fetching its own data:
 * folded by default, with the 24 h total in its title so it reads without
 * opening. Renders nothing without a service.
 */
export function OpenSkyCreditsChart() {
  const [report, setReport] = useState<CreditsReport | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      getOpenSkyCredits()
        .then((r) => live && setReport(r))
        .catch(() => live && setReport(null));
    load();
    const timer = setInterval(load, CREDITS_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  if (!report) return null;
  return (
    <details className="group border-b border-slate-800" data-testid="dbhist-opensky-credits">
      <summary className="flex items-center gap-1.5 cursor-pointer select-none px-3 py-1.5 text-xs font-semibold text-slate-400 list-none [&::-webkit-details-marker]:hidden">
        <span className="text-[10px] transition-transform duration-150 group-open:rotate-90">▶</span>
        <span className="flex-1 text-[10px] uppercase tracking-wide text-slate-500">OpenSky Credits · 24 h</span>
        <span className="text-[10px] font-normal text-slate-400 font-mono">{creditsTotal(report)}</span>
      </summary>
      <div className="px-3 pb-2">
        <OpenSkyCreditsView report={report} header={false} />
      </div>
    </details>
  );
}

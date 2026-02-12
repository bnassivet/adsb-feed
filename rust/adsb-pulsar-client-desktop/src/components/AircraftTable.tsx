"use client";
import { useState } from "react";
import type { AircraftTrack } from "@/lib/types";
import { altitudeToColor } from "@/lib/colors";

type SortKey =
  | "callsign"
  | "hex_ident"
  | "altitude"
  | "ground_speed"
  | "squawk";

interface Props {
  tracks: AircraftTrack[];
  historyTracks?: AircraftTrack[];
}

function timeAgo(lastSeen: number): string {
  const seconds = Math.floor((Date.now() - lastSeen) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m ago`;
}

export function AircraftTable({ tracks, historyTracks = [] }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("callsign");
  const [sortAsc, setSortAsc] = useState(true);

  function sortTracks(list: AircraftTrack[]) {
    return [...list].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortAsc ? cmp : -cmp;
    });
  }

  const sorted = sortTracks(tracks);
  const sortedHistory = sortTracks(historyTracks);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  function SortHeader({ label, field }: { label: string; field: SortKey }) {
    return (
      <th
        className="px-3 py-2 text-left cursor-pointer hover:text-slate-200 select-none"
        onClick={() => handleSort(field)}
      >
        {label}
        {sortKey === field && (
          <span className="ml-1">{sortAsc ? "\u25B2" : "\u25BC"}</span>
        )}
      </th>
    );
  }

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-xs">
        <thead className="bg-slate-800 text-slate-400 sticky top-0">
          <tr>
            <SortHeader label="Callsign" field="callsign" />
            <SortHeader label="Hex" field="hex_ident" />
            <SortHeader label="Alt (ft)" field="altitude" />
            <SortHeader label="Spd (kts)" field="ground_speed" />
            <th className="px-3 py-2 text-left">Hdg</th>
            <th className="px-3 py-2 text-left">V/S</th>
            <SortHeader label="Squawk" field="squawk" />
            <th className="px-3 py-2 text-left">Lat</th>
            <th className="px-3 py-2 text-left">Lon</th>
          </tr>
        </thead>
        <tbody className="text-slate-300">
          {sorted.map((t) => (
            <tr
              key={t.hex_ident}
              className="border-b border-slate-800 hover:bg-slate-800/50"
            >
              <td className="px-3 py-1.5 font-mono font-semibold">
                {t.hex_ident.startsWith("SIM-") && (
                  <span className="inline-block mr-1.5 px-1 py-0.5 text-[9px] font-bold rounded bg-emerald-600/30 text-emerald-400 leading-none">
                    SIM
                  </span>
                )}
                {t.callsign ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-400">
                {t.hex_ident}
              </td>
              <td className="px-3 py-1.5 font-mono">
                <span style={{ color: altitudeToColor(t.altitude) }}>
                  {t.altitude?.toLocaleString() ?? "—"}
                </span>
              </td>
              <td className="px-3 py-1.5 font-mono">
                {t.ground_speed?.toFixed(0) ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono">
                {t.track?.toFixed(0) ?? "—"}{t.track !== null ? "\u00B0" : ""}
              </td>
              <td className="px-3 py-1.5 font-mono">
                {t.vertical_rate?.toFixed(0) ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-400">
                {t.squawk ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-500">
                {t.latitude?.toFixed(4) ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-500">
                {t.longitude?.toFixed(4) ?? "—"}
              </td>
            </tr>
          ))}

          {/* History divider */}
          {sortedHistory.length > 0 && (
            <tr>
              <td colSpan={9} className="px-3 py-1 bg-slate-800/80">
                <span className="text-[10px] text-slate-500 uppercase tracking-wider">
                  History ({sortedHistory.length})
                </span>
              </td>
            </tr>
          )}

          {/* History rows — dimmed */}
          {sortedHistory.map((t) => (
            <tr
              key={`hist-${t.hex_ident}`}
              className="border-b border-slate-800 hover:bg-slate-800/50 opacity-40"
            >
              <td className="px-3 py-1.5 font-mono font-semibold">
                {t.callsign ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-400">
                {t.hex_ident}
              </td>
              <td className="px-3 py-1.5 font-mono">
                <span style={{ color: altitudeToColor(t.altitude) }}>
                  {t.altitude?.toLocaleString() ?? "—"}
                </span>
              </td>
              <td className="px-3 py-1.5 font-mono">
                {t.ground_speed?.toFixed(0) ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono" colSpan={2}>
                <span className="text-slate-500 italic">
                  {timeAgo(t.last_seen)}
                </span>
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-400">
                {t.squawk ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-500">
                {t.latitude?.toFixed(4) ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-500">
                {t.longitude?.toFixed(4) ?? "—"}
              </td>
            </tr>
          ))}

          {sorted.length === 0 && sortedHistory.length === 0 && (
            <tr>
              <td
                colSpan={9}
                className="px-3 py-8 text-center text-slate-500"
              >
                No aircraft tracked
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

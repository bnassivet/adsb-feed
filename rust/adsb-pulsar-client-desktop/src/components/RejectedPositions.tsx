"use client";
import { useEffect, useState } from "react";
import { getRejectedPositions } from "@/lib/commands";
import type { RejectedPosition, RejectedPositionPage } from "@/lib/types";
import {
  REASON_LABELS,
  REASON_TITLES,
  formatKnots,
  isShown,
  rejectedKey,
  setShown,
} from "@/lib/rejected-positions";
import { EyeIcon } from "./EyeIcon";

/** Rows fetched at most; the total in the range is shown beside it. */
const LIMIT = 500;

const NO_ROWS: RejectedPosition[] = [];

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; page: RejectedPositionPage };

const toolButton =
  "px-1.5 py-0.5 text-[10px] rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent";

/**
 * Positions the quarantine sweep moved out of `positions` as decode glitches,
 * for the DB History time range. Mounted only while its section is open.
 *
 * What is on the map is `shown`, owned by the page so it outlives this
 * section; the selection is local and only drives the "selected" buttons.
 */
export function RejectedPositions({
  startMs,
  endMs,
  formatTime,
  shown = NO_ROWS,
  onShownChange,
}: {
  startMs: number;
  endMs: number;
  formatTime: (ms: number) => string;
  shown?: RejectedPosition[];
  onShownChange?: (shown: RejectedPosition[]) => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    getRejectedPositions({ start_ms: startMs, end_ms: endMs, limit: LIMIT })
      .then((page) => {
        if (!cancelled) setLoad({ kind: "ready", page });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoad({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [startMs, endMs]);

  if (load.kind === "loading") {
    return <div className="text-[10px] text-slate-500 py-1">Loading…</div>;
  }
  if (load.kind === "error") {
    return (
      <div data-testid="rejected-error" className="text-[10px] text-red-400 py-1">
        {load.message}
      </div>
    );
  }
  const { rows, total } = load.page;
  if (rows.length === 0) {
    return (
      <div data-testid="rejected-empty" className="text-[10px] text-slate-500 py-1">
        No rejected positions in this time range.
      </div>
    );
  }

  const selectedRows = rows.filter((r) => selected.has(rejectedKey(r)));
  const allSelected = selectedRows.length === rows.length;
  const show = (subset: RejectedPosition[], on: boolean) =>
    onShownChange?.(setShown(shown, subset, on));
  const toggleSelected = (r: RejectedPosition) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const key = rejectedKey(r);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div data-testid="rejected-count" className="text-[10px] text-slate-500">
          {rows.length < total ? `${rows.length} of ${total}` : `${total}`} rejected
        </div>
        {onShownChange && (
          <div className="flex gap-1">
            <button type="button" className={toolButton} disabled={selectedRows.length === 0} onClick={() => show(selectedRows, true)}>
              Show selected
            </button>
            <button type="button" className={toolButton} disabled={selectedRows.length === 0} onClick={() => show(selectedRows, false)}>
              Hide selected
            </button>
            <button type="button" className={toolButton} onClick={() => show(rows, true)}>
              Show all
            </button>
            <button type="button" className={toolButton} onClick={() => show(rows, false)}>
              Hide all
            </button>
          </div>
        )}
      </div>
      <div className="max-h-64 overflow-auto">
        <table className="w-full text-[10px] font-mono">
          <thead className="sticky top-0 bg-slate-900 text-slate-500 text-left">
            <tr>
              {onShownChange && (
                <>
                  <th className="pr-1 font-normal">
                    <input
                      type="checkbox"
                      aria-label="Select all rejected positions"
                      className="accent-cyan-500"
                      checked={allSelected}
                      onChange={() =>
                        setSelected(allSelected ? new Set() : new Set(rows.map(rejectedKey)))
                      }
                    />
                  </th>
                  <th className="pr-1 font-normal" aria-label="On map" />
                </>
              )}
              <th className="pr-2 font-normal">Time</th>
              <th className="pr-2 font-normal">Aircraft</th>
              <th className="pr-2 font-normal">Position</th>
              <th className="pr-2 font-normal text-right">Alt ft</th>
              <th className="pr-2 font-normal text-right">NM</th>
              <th
                className="pr-2 font-normal text-right"
                title="Impossible speed: the lowest speed at which any neighbouring fix of the aircraft reaches this one"
              >
                Speed kt
              </th>
              <th className="font-normal">Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const key = rejectedKey(r);
              const onMap = isShown(shown, r);
              return (
                <tr key={key} data-testid="rejected-row" className="text-slate-300 align-top">
                  {onShownChange && (
                    <>
                      <td className="pr-1">
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.hex_ident}`}
                          className="accent-cyan-500"
                          checked={selected.has(key)}
                          onChange={() => toggleSelected(r)}
                        />
                      </td>
                      <td className="pr-1">
                        <button
                          type="button"
                          aria-pressed={onMap}
                          aria-label={onMap ? "Hide from map" : "Show on map"}
                          title={onMap ? "Hide from map" : "Show on map"}
                          className={onMap ? "text-cyan-300" : "text-slate-600 hover:text-slate-300"}
                          onClick={() => show([r], !onMap)}
                        >
                          <EyeIcon open={onMap} />
                        </button>
                      </td>
                    </>
                  )}
                  <td className="pr-2 whitespace-nowrap">{formatTime(r.timestamp_ms)}</td>
                  <td className="pr-2">
                    {r.callsign && <div className="text-cyan-200">{r.callsign}</div>}
                    <div className="text-slate-500">{r.hex_ident}</div>
                  </td>
                  <td className="pr-2 whitespace-nowrap">
                    {r.latitude !== null && r.longitude !== null
                      ? `${r.latitude.toFixed(4)}, ${r.longitude.toFixed(4)}`
                      : "—"}
                  </td>
                  <td className="pr-2 text-right">
                    {r.altitude !== null ? r.altitude.toLocaleString("en-US") : "—"}
                  </td>
                  <td className="pr-2 text-right">
                    {r.distance_nm !== null ? Math.round(r.distance_nm) : "—"}
                  </td>
                  <td className="pr-2 text-right" data-testid="rejected-speed">
                    {r.implied_speed_kt !== null ? formatKnots(r.implied_speed_kt) : "—"}
                  </td>
                  <td
                    className={r.reason === "out_of_range" ? "text-orange-400" : "text-yellow-400"}
                    title={REASON_TITLES[r.reason]}
                  >
                    {REASON_LABELS[r.reason]}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

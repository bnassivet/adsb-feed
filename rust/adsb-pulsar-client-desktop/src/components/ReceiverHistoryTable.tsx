"use client";

import { useCallback, useEffect, useState } from "react";
import { applyReceiverChange, getReceiverLocations } from "@/lib/commands";
import type { LocationChange, LocationPeriod, ReceiverPosition } from "@/lib/types";

interface ReceiverHistoryTableProps {
  sourceId: string;
  /** Called after a change was written, e.g. to refresh the receiver list. */
  onChanged?: () => void;
}

/** A number typed into a field, or null when it is not one. */
function parseNumber(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString();
}

/**
 * One receiver's location history (SCD2): where it was, from when to when.
 *
 * A move splits the period it falls in, so the data recorded before it keeps
 * the old position; a correction fixes a period's position without moving its
 * dates; removing a period lets the one before it stretch over its time. The
 * rules are the backend's -- a refused edit shows the rule it broke.
 */
export function ReceiverHistoryTable({ sourceId, onChanged }: ReceiverHistoryTableProps) {
  const [periods, setPeriods] = useState<LocationPeriod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [moveLat, setMoveLat] = useState("");
  const [moveLon, setMoveLon] = useState("");
  const [moveAlt, setMoveAlt] = useState("");
  const [moveAt, setMoveAt] = useState("");
  const [moveNote, setMoveNote] = useState("");

  const [editing, setEditing] = useState<number | null>(null);
  const [fixLat, setFixLat] = useState("");
  const [fixLon, setFixLon] = useState("");
  const [fixAlt, setFixAlt] = useState("");

  const load = useCallback(async () => {
    try {
      setPeriods(await getReceiverLocations(sourceId));
      setError(null);
    } catch (e) {
      setPeriods([]);
      setError(String(e));
    }
  }, [sourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (change: LocationChange, note?: string): Promise<boolean> => {
    setBusy(true);
    try {
      const next = await applyReceiverChange(sourceId, change, note);
      if (next) setPeriods(next);
      setError(null);
      onChanged?.();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const movePosition: ReceiverPosition | null = (() => {
    const latitude = parseNumber(moveLat);
    const longitude = parseNumber(moveLon);
    if (latitude == null || longitude == null) return null;
    return { latitude, longitude, altitude_ft: parseNumber(moveAlt) };
  })();
  const moveAtMs = moveAt ? new Date(moveAt).getTime() : NaN;
  const canMove = movePosition != null && Number.isFinite(moveAtMs) && !busy;

  const recordMove = async () => {
    if (!movePosition || !Number.isFinite(moveAtMs)) return;
    const ok = await send(
      { kind: "move", position: movePosition, at_ms: moveAtMs },
      moveNote.trim() || undefined,
    );
    if (ok) {
      setMoveLat("");
      setMoveLon("");
      setMoveAlt("");
      setMoveAt("");
      setMoveNote("");
    }
  };

  const startCorrecting = (p: LocationPeriod) => {
    setEditing(p.valid_from_ms);
    setFixLat(String(p.position.latitude));
    setFixLon(String(p.position.longitude));
    setFixAlt(p.position.altitude_ft != null ? String(p.position.altitude_ft) : "");
  };

  const saveCorrection = async () => {
    const latitude = parseNumber(fixLat);
    const longitude = parseNumber(fixLon);
    if (editing == null || latitude == null || longitude == null) return;
    const ok = await send({
      kind: "correct",
      valid_from_ms: editing,
      position: { latitude, longitude, altitude_ft: parseNumber(fixAlt) },
    });
    if (ok) setEditing(null);
  };

  const input =
    "w-full rounded bg-slate-800 border border-slate-700 px-2 py-1 text-xs text-slate-200";

  return (
    <div className="space-y-3">
      {periods == null ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : periods.length === 0 ? (
        <p className="text-xs text-slate-500">
          No location history for {sourceId} yet. The recorder starts one from its
          configuration; you can also record a move below.
        </p>
      ) : (
        <table className="w-full text-xs text-slate-300">
          <thead className="text-slate-500">
            <tr>
              <th className="text-left font-normal">From</th>
              <th className="text-left font-normal">Until</th>
              <th className="text-right font-normal">Latitude</th>
              <th className="text-right font-normal">Longitude</th>
              <th className="text-right font-normal">Alt</th>
              <th className="text-left font-normal pl-2">Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {periods.map((p) =>
              editing === p.valid_from_ms ? (
                <tr key={p.valid_from_ms} data-testid="receiver-period">
                  <td>{formatWhen(p.valid_from_ms)}</td>
                  <td>{p.valid_to_ms == null ? "current" : formatWhen(p.valid_to_ms)}</td>
                  <td>
                    <input aria-label="Corrected latitude" className={input} value={fixLat} onChange={(e) => setFixLat(e.target.value)} />
                  </td>
                  <td>
                    <input aria-label="Corrected longitude" className={input} value={fixLon} onChange={(e) => setFixLon(e.target.value)} />
                  </td>
                  <td>
                    <input aria-label="Corrected altitude" className={input} value={fixAlt} onChange={(e) => setFixAlt(e.target.value)} />
                  </td>
                  <td colSpan={2} className="pl-2 whitespace-nowrap">
                    <button type="button" className="text-sky-400 mr-2" disabled={busy} onClick={() => void saveCorrection()}>
                      Save correction
                    </button>
                    <button type="button" className="text-slate-400" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={p.valid_from_ms} data-testid="receiver-period">
                  <td>{formatWhen(p.valid_from_ms)}</td>
                  <td>{p.valid_to_ms == null ? "current" : formatWhen(p.valid_to_ms)}</td>
                  <td className="text-right tabular-nums">{p.position.latitude.toFixed(6)}</td>
                  <td className="text-right tabular-nums">{p.position.longitude.toFixed(6)}</td>
                  <td className="text-right tabular-nums">
                    {p.position.altitude_ft != null ? `${p.position.altitude_ft} ft` : "–"}
                  </td>
                  <td className="pl-2 text-slate-400" title={p.note ?? undefined}>
                    {p.origin}
                    {p.note ? ` · ${p.note}` : ""}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <button type="button" className="text-sky-400 mr-2" disabled={busy} onClick={() => startCorrecting(p)}>
                      Correct
                    </button>
                    <button type="button" className="text-rose-400" disabled={busy} onClick={() => void send({ kind: "remove", valid_from_ms: p.valid_from_ms })}>
                      Remove
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}

      <div className="grid grid-cols-5 gap-2 items-end">
        <label className="text-xs text-slate-400">
          Latitude
          <input aria-label="New latitude" className={input} inputMode="decimal" value={moveLat} onChange={(e) => setMoveLat(e.target.value)} />
        </label>
        <label className="text-xs text-slate-400">
          Longitude
          <input aria-label="New longitude" className={input} inputMode="decimal" value={moveLon} onChange={(e) => setMoveLon(e.target.value)} />
        </label>
        <label className="text-xs text-slate-400">
          Altitude (ft)
          <input aria-label="New altitude" className={input} inputMode="decimal" value={moveAlt} onChange={(e) => setMoveAlt(e.target.value)} />
        </label>
        <label className="text-xs text-slate-400 col-span-2">
          Moved at (local time)
          <input aria-label="Moved at" type="datetime-local" className={input} value={moveAt} onChange={(e) => setMoveAt(e.target.value)} />
        </label>
        <label className="text-xs text-slate-400 col-span-4">
          Note
          <input aria-label="Note" className={input} value={moveNote} onChange={(e) => setMoveNote(e.target.value)} />
        </label>
        <button
          type="button"
          className="rounded bg-sky-700 px-2 py-1 text-xs text-white disabled:opacity-40"
          disabled={!canMove}
          onClick={() => void recordMove()}
        >
          Record move
        </button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

import type { ReceiverSummary } from "@/lib/types";

interface ReceiverSelectorProps {
  receivers: ReceiverSummary[];
  selectedId: string | null;
  onSelect: (sourceId: string) => void;
}

/**
 * Picks the receiver the map centre, range lines, details and radar are
 * measured from. Rendered only when the database holds more than one: with
 * one there is nothing to choose.
 */
export function ReceiverSelector({ receivers, selectedId, onSelect }: ReceiverSelectorProps) {
  if (receivers.length < 2) return null;
  return (
    <label className="flex items-center gap-1 text-xs text-slate-400">
      Receiver
      <select
        className="rounded bg-slate-800 border border-slate-600 px-1 py-0.5 text-slate-200"
        value={selectedId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
      >
        {receivers.map((r) => (
          <option key={r.source_id} value={r.source_id}>
            {r.current ? r.source_id : `${r.source_id} (no location)`}
          </option>
        ))}
      </select>
    </label>
  );
}

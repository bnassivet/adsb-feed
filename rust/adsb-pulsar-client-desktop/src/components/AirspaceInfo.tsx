"use client";
import type { Airspace } from "@/lib/airspace";

const MAX_SHOWN = 6;

/**
 * The airspaces stacked under the cursor, lowest first. A box rather than a
 * Leaflet tooltip: airspaces overlap, Leaflet reports only the top polygon, and
 * interactive polygons would steal hover from the density layer underneath.
 */
export function AirspaceInfo({ stack }: { stack: Airspace[] }) {
  if (stack.length === 0) return null;
  const shown = stack.slice(0, MAX_SHOWN);
  return (
    <div className="absolute bottom-6 left-2.5 z-[1000] max-w-xs pointer-events-none rounded bg-slate-900/85 px-2 py-1.5 text-[11px] leading-tight text-slate-200 shadow">
      <ul className="flex flex-col gap-1">
        {shown.map((a) => (
          <li key={a.id}>
            <div className="font-semibold">{a.name}</div>
            <div className="text-slate-400">
              {a.typeLabel}
              {a.classLabel ? ` ${a.classLabel}` : ""} · {a.lower} – {a.upper}
            </div>
          </li>
        ))}
      </ul>
      {stack.length > MAX_SHOWN && <div className="mt-1 text-slate-500">+{stack.length - MAX_SHOWN} more</div>}
    </div>
  );
}

"use client";
import { useEffect, useRef } from "react";
import type { MenuItem } from "@/lib/opensky-menu";

export interface TrackContextMenuProps {
  /** Pixel position on screen (client coordinates). */
  x: number;
  y: number;
  /** The track it acts on: callsign and hex. */
  title: string;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * The context menu of one track (right-click on its aircraft, its line or its
 * table row): every OpenSky action for it (opensky-menu.ts). Closes on a pick,
 * on Escape, and on a click anywhere else.
 */
export function TrackContextMenu({ x, y, title, items, onClose }: TrackContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[1300] bg-slate-900 border border-slate-700 rounded shadow-lg py-1 min-w-[200px]"
      style={{ left: x, top: y }}
    >
      <div className="px-3 py-1 text-[10px] text-slate-400 border-b border-slate-800">{title}</div>
      <div className="px-3 pt-1 text-[10px] text-violet-400 uppercase">OpenSky</div>
      {items.length === 0 && <div className="px-3 py-1.5 text-xs text-slate-500">No OpenSky action for this track</div>}
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          title={item.title}
          className="w-full px-3 py-1.5 text-xs text-left text-slate-200 hover:bg-slate-700 transition disabled:opacity-40 disabled:hover:bg-transparent"
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

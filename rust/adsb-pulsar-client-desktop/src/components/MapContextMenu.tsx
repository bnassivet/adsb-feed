"use client";

export interface MapContextMenuProps {
  /** Pixel position on screen. */
  x: number;
  y: number;
  /** Map coordinates of the right-click. */
  lat: number;
  lng: number;
  onCreateEvent: (lat: number, lng: number) => void;
  onClose: () => void;
}

export function MapContextMenu({
  x,
  y,
  lat,
  lng,
  onCreateEvent,
  onClose,
}: MapContextMenuProps) {
  return (
    <div
      className="fixed z-[1300] bg-slate-900 border border-slate-700 rounded shadow-lg py-1 min-w-[160px]"
      style={{ left: x, top: y }}
    >
      <button
        className="w-full px-3 py-1.5 text-xs text-left text-slate-200 hover:bg-slate-700 transition"
        onClick={() => {
          onCreateEvent(lat, lng);
          onClose();
        }}
      >
        Create Event Here
      </button>
      <div className="px-3 py-0.5 text-[10px] text-slate-600 border-t border-slate-800">
        {lat.toFixed(5)}, {lng.toFixed(5)}
      </div>
    </div>
  );
}

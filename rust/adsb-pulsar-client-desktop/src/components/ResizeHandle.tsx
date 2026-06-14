"use client";
import { useCallback } from "react";

interface Props {
  onResize: (deltaY: number) => void;
  onResizeEnd: () => void;
}

export function ResizeHandle({ onResize, onResizeEnd }: Props) {
  // Self-contained drag: move/up listeners are created on mousedown and removed on mouseup, with
  // the last Y tracked in the closure. Emits incremental deltaY. Avoids handler self-reference.
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      let lastY = e.clientY;

      function onMove(ev: MouseEvent) {
        const delta = ev.clientY - lastY;
        lastY = ev.clientY;
        onResize(delta);
      }
      function onUp() {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        onResizeEnd();
      }

      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [onResize, onResizeEnd],
  );

  return (
    <div
      onMouseDown={handleMouseDown}
      className="h-1 cursor-row-resize bg-slate-700 hover:bg-blue-500 transition-colors flex-shrink-0 group relative"
    >
      {/* Grip indicator */}
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        <span className="w-6 h-0.5 bg-blue-300 rounded-full" />
      </div>
    </div>
  );
}

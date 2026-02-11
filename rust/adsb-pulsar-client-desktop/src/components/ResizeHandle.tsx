"use client";
import { useCallback, useRef } from "react";

interface Props {
  onResize: (deltaY: number) => void;
  onResizeEnd: () => void;
}

export function ResizeHandle({ onResize, onResizeEnd }: Props) {
  const lastY = useRef(0);
  const isDragging = useRef(false);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientY - lastY.current;
      lastY.current = e.clientY;
      onResize(delta);
    },
    [onResize],
  );

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
    onResizeEnd();
  }, [handleMouseMove, onResizeEnd]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      lastY.current = e.clientY;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [handleMouseMove, handleMouseUp],
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

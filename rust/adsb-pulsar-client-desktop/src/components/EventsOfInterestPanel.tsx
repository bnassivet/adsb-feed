"use client";
import { useCallback, type ReactNode } from "react";

const MIN_DOCKED_WIDTH = 240;
const MAX_DOCKED_WIDTH = 560;
const COLLAPSED_WIDTH = 32;

function VisibilityToggleButton({ allHidden, onToggle }: { allHidden: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={allHidden ? "Show all on map" : "Hide all from map"}
      className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-700 rounded transition"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        {allHidden ? (
          <>
            <path d="M2 2L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M3.5 5.5C2.3 6.5 1.5 8 1.5 8s2.5 5 6.5 5c1 0 1.9-.3 2.7-.7M12.5 10.5C13.7 9.5 14.5 8 14.5 8s-2.5-5-6.5-5c-1 0-1.9.3-2.7.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </>
        ) : (
          <>
            <path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5S1.5 8 1.5 8z" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
          </>
        )}
      </svg>
    </button>
  );
}

export interface EventsOfInterestPanelProps {
  isOpen: boolean;
  onToggle: () => void;
  onNewEvent: () => void;
  /** Docked mode: expanded width */
  width: number;
  onWidthChange: (w: number) => void;
  /** Docked expanded vs collapsed */
  dockedExpanded: boolean;
  onDockedExpandedChange: (v: boolean) => void;
  /** Floating mode */
  floating: boolean;
  onFloatingChange: (v: boolean) => void;
  /** Floating position/size */
  floatX: number;
  floatY: number;
  floatW: number;
  floatH: number;
  onFloatPosChange: (x: number, y: number) => void;
  onFloatSizeChange: (w: number, h: number) => void;
  /** Whether all events are currently hidden from the map */
  allHidden?: boolean;
  /** Toggle all events visibility on/off */
  onToggleAllVisibility?: () => void;
  children?: ReactNode;
}

export function EventsOfInterestPanel({
  isOpen,
  onToggle,
  onNewEvent,
  width,
  onWidthChange,
  dockedExpanded,
  onDockedExpandedChange,
  floating,
  onFloatingChange,
  floatX,
  floatY,
  floatW,
  floatH,
  onFloatPosChange,
  onFloatSizeChange,
  allHidden,
  onToggleAllVisibility,
  children,
}: EventsOfInterestPanelProps) {
  if (!isOpen) return null;

  if (floating) {
    return (
      <FloatingPanel
        x={floatX}
        y={floatY}
        w={floatW}
        h={floatH}
        onPosChange={onFloatPosChange}
        onSizeChange={onFloatSizeChange}
        onClose={onToggle}
        onPin={() => onFloatingChange(false)}
        onNewEvent={onNewEvent}
        allHidden={allHidden}
        onToggleAllVisibility={onToggleAllVisibility}
      >
        {children}
      </FloatingPanel>
    );
  }

  if (!dockedExpanded) {
    return (
      <div
        data-testid="events-panel-docked"
        className="flex flex-col items-center justify-center bg-slate-900 border-l border-slate-700 flex-shrink-0"
        style={{ width: COLLAPSED_WIDTH }}
      >
        <button
          onClick={() => onDockedExpandedChange(true)}
          title="Expand Events"
          className="p-1 text-amber-400 hover:text-amber-200 hover:bg-slate-700 rounded transition text-xs font-mono"
        >
          {"<<"}
        </button>
      </div>
    );
  }

  return (
    <DockedPanel
      width={width}
      onWidthChange={onWidthChange}
      onCollapse={() => onDockedExpandedChange(false)}
      onUnpin={() => onFloatingChange(true)}
      onNewEvent={onNewEvent}
      allHidden={allHidden}
      onToggleAllVisibility={onToggleAllVisibility}
    >
      {children}
    </DockedPanel>
  );
}

function DockedPanel({
  width,
  onWidthChange,
  onCollapse,
  onUnpin,
  onNewEvent,
  allHidden,
  onToggleAllVisibility,
  children,
}: {
  width: number;
  onWidthChange: (w: number) => void;
  onCollapse: () => void;
  onUnpin: () => void;
  onNewEvent: () => void;
  allHidden?: boolean;
  onToggleAllVisibility?: () => void;
  children?: ReactNode;
}) {
  // Self-contained drag: listeners created on mousedown capture the start width/x and are removed
  // on mouseup. Avoids render-time ref writes and handler self-reference. Right-docked, so moving
  // left expands (delta = startX - clientX).
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;

      function onMove(ev: MouseEvent) {
        const delta = startX - ev.clientX;
        onWidthChange(Math.max(MIN_DOCKED_WIDTH, Math.min(MAX_DOCKED_WIDTH, startWidth + delta)));
      }
      function onUp() {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }

      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [width, onWidthChange],
  );

  return (
    <div
      data-testid="events-panel-docked"
      className="flex flex-row bg-slate-900 border-l border-slate-700 flex-shrink-0 overflow-hidden"
      style={{ width }}
    >
      {/* Left edge: draggable resize strip */}
      <div
        onMouseDown={handleMouseDown}
        className="w-1 cursor-col-resize bg-slate-700 hover:bg-amber-500 transition-colors flex-shrink-0"
      />

      {/* Panel content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 flex-shrink-0">
          <span className="text-xs font-semibold text-amber-400 uppercase tracking-wide">
            Events
          </span>
          <div className="flex items-center gap-1">
            {onToggleAllVisibility && (
              <VisibilityToggleButton allHidden={allHidden ?? false} onToggle={onToggleAllVisibility} />
            )}
            <button
              onClick={onNewEvent}
              className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition"
              title="Create new event"
            >
              + New
            </button>
            <button
              onClick={onUnpin}
              title="Undock to floating window"
              className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-700 rounded transition"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" strokeDasharray="3 2" />
              </svg>
            </button>
            <button
              onClick={onCollapse}
              title="Collapse panel"
              className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded transition text-xs font-mono"
            >
              {">>"}
            </button>
          </div>
        </div>

        {/* Body */}
        {children}
      </div>
    </div>
  );
}

function FloatingPanel({
  x,
  y,
  w,
  h,
  onPosChange,
  onSizeChange,
  onClose,
  onPin,
  onNewEvent,
  allHidden,
  onToggleAllVisibility,
  children,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  onPosChange: (x: number, y: number) => void;
  onSizeChange: (w: number, h: number) => void;
  onClose: () => void;
  onPin: () => void;
  onNewEvent: () => void;
  allHidden?: boolean;
  onToggleAllVisibility?: () => void;
  children?: ReactNode;
}) {
  // Self-contained drag/resize: each mousedown captures the start mouse/position/size in the
  // closure and attaches move/up listeners removed on mouseup. Avoids ref-backed drag state and
  // handler self-reference (Rules of React / React Compiler safe).
  const handleDragDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const mx = e.clientX;
      const my = e.clientY;
      const startX = x;
      const startY = y;

      function onMove(ev: MouseEvent) {
        onPosChange(startX + (ev.clientX - mx), startY + (ev.clientY - my));
      }
      function onUp() {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }

      document.body.style.userSelect = "none";
      document.body.style.cursor = "move";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [x, y, onPosChange],
  );

  const handleResizeDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const mx = e.clientX;
      const my = e.clientY;
      const startW = w;
      const startH = h;

      function onMove(ev: MouseEvent) {
        onSizeChange(Math.max(280, startW + (ev.clientX - mx)), Math.max(200, startH + (ev.clientY - my)));
      }
      function onUp() {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }

      document.body.style.userSelect = "none";
      document.body.style.cursor = "nwse-resize";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [w, h, onSizeChange],
  );

  return (
    <div
      data-testid="events-panel-floating"
      className="fixed z-[1100] flex flex-col bg-slate-900 border border-slate-600 rounded-lg shadow-2xl overflow-hidden"
      style={{ left: x, top: y, width: w, height: h }}
    >
      {/* Title bar — draggable */}
      <div
        onMouseDown={handleDragDown}
        className="flex items-center justify-between px-3 py-2 bg-slate-800 border-b border-slate-700 cursor-move flex-shrink-0"
      >
        <span className="text-xs font-semibold text-amber-400 uppercase tracking-wide">
          Events
        </span>
        <div className="flex items-center gap-1">
          {onToggleAllVisibility && (
            <VisibilityToggleButton allHidden={allHidden ?? false} onToggle={onToggleAllVisibility} />
          )}
          <button
            onClick={onNewEvent}
            className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition"
            title="Create new event"
          >
            + New
          </button>
          <button
            onClick={onPin}
            title="Dock to right side"
            className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-700 rounded transition"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <line x1="9" y1="1" x2="9" y2="13" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          <button
            onClick={onClose}
            title="Close"
            className="p-1 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded transition text-xs font-mono"
          >
            ×
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {children}
      </div>

      {/* Bottom-right resize corner */}
      <div
        onMouseDown={handleResizeDown}
        className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
        style={{ touchAction: "none" }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" className="text-slate-600">
          <path d="M14 2L2 14M14 6L6 14M14 10L10 14" stroke="currentColor" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}

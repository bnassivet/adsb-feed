"use client";
import { useCallback, useRef, type ReactNode } from "react";

const MIN_DOCKED_WIDTH = 280;
const MAX_DOCKED_WIDTH = 560;
const COLLAPSED_WIDTH = 32;

interface Props {
  isOpen: boolean;
  onToggle: () => void;
  width: number;
  onWidthChange: (w: number) => void;
  dockedExpanded: boolean;
  onDockedExpandedChange: (v: boolean) => void;
  floating: boolean;
  onFloatingChange: (v: boolean) => void;
  floatX: number;
  floatY: number;
  floatW: number;
  floatH: number;
  onFloatPosChange: (x: number, y: number) => void;
  onFloatSizeChange: (w: number, h: number) => void;
  onNewConversation?: () => void;
  children?: ReactNode;
}

function NewConversationButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="New Conversation"
      aria-label="New Conversation"
      className="p-1 text-slate-400 hover:text-violet-300 hover:bg-slate-700 rounded transition"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path
          d="M7 2v10M2 7h10"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

export function AIChatPanel({
  isOpen,
  onToggle,
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
  onNewConversation,
  children,
}: Props) {
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
        onNewConversation={onNewConversation}
      >
        {children}
      </FloatingPanel>
    );
  }

  if (!dockedExpanded) {
    return (
      <div
        data-testid="aichat-panel-collapsed"
        className="flex flex-col items-center justify-center bg-slate-900 border-l border-slate-700 flex-shrink-0"
        style={{ width: COLLAPSED_WIDTH }}
      >
        <button
          onClick={() => onDockedExpandedChange(true)}
          title="Expand AI Chat"
          className="p-1 text-violet-400 hover:text-violet-200 hover:bg-slate-700 rounded transition text-xs font-mono"
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
      onNewConversation={onNewConversation}
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
  onNewConversation,
  children,
}: {
  width: number;
  onWidthChange: (w: number) => void;
  onCollapse: () => void;
  onUnpin: () => void;
  onNewConversation?: () => void;
  children?: ReactNode;
}) {
  const lastX = useRef(0);
  const isDragging = useRef(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = lastX.current - e.clientX;
      lastX.current = e.clientX;
      onWidthChange(Math.max(MIN_DOCKED_WIDTH, Math.min(MAX_DOCKED_WIDTH, widthRef.current + delta)));
    },
    [onWidthChange],
  );

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseMove]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      lastX.current = e.clientX;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [handleMouseMove, handleMouseUp],
  );

  return (
    <div
      data-testid="aichat-panel-docked"
      className="flex flex-row bg-slate-900 border-l border-slate-700 flex-shrink-0 overflow-hidden"
      style={{ width }}
    >
      {/* Left edge: draggable resize strip */}
      <div
        onMouseDown={handleMouseDown}
        className="w-1 cursor-col-resize bg-slate-700 hover:bg-violet-500 transition-colors flex-shrink-0"
      />

      {/* Panel content */}
      <div className="flex-1 overflow-hidden flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 flex-shrink-0">
          <span className="text-xs font-semibold text-violet-400 uppercase tracking-wide">
            AI Chat
          </span>
          <div className="flex items-center gap-1">
            {onNewConversation && (
              <NewConversationButton onClick={onNewConversation} />
            )}
            <button
              onClick={onUnpin}
              title="Undock to floating window"
              className="p-1 text-slate-400 hover:text-violet-300 hover:bg-slate-700 rounded transition"
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
  onNewConversation,
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
  onNewConversation?: () => void;
  children?: ReactNode;
}) {
  const isDragging = useRef(false);
  const isResizing = useRef(false);
  const startPos = useRef({ mx: 0, my: 0, x: 0, y: 0, w: 0, h: 0 });

  const handleDragMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging.current) return;
      const dx = e.clientX - startPos.current.mx;
      const dy = e.clientY - startPos.current.my;
      onPosChange(startPos.current.x + dx, startPos.current.y + dy);
    },
    [onPosChange],
  );

  const handleDragUp = useCallback(() => {
    isDragging.current = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", handleDragMove);
    document.removeEventListener("mouseup", handleDragUp);
  }, [handleDragMove]);

  const handleDragDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startPos.current = { mx: e.clientX, my: e.clientY, x, y, w, h };
      document.body.style.userSelect = "none";
      document.body.style.cursor = "move";
      document.addEventListener("mousemove", handleDragMove);
      document.addEventListener("mouseup", handleDragUp);
    },
    [x, y, w, h, handleDragMove, handleDragUp],
  );

  const handleResizeMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing.current) return;
      const dx = e.clientX - startPos.current.mx;
      const dy = e.clientY - startPos.current.my;
      onSizeChange(
        Math.max(280, startPos.current.w + dx),
        Math.max(300, startPos.current.h + dy),
      );
    },
    [onSizeChange],
  );

  const handleResizeUp = useCallback(() => {
    isResizing.current = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", handleResizeMove);
    document.removeEventListener("mouseup", handleResizeUp);
  }, [handleResizeMove]);

  const handleResizeDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      startPos.current = { mx: e.clientX, my: e.clientY, x, y, w, h };
      document.body.style.userSelect = "none";
      document.body.style.cursor = "nwse-resize";
      document.addEventListener("mousemove", handleResizeMove);
      document.addEventListener("mouseup", handleResizeUp);
    },
    [x, y, w, h, handleResizeMove, handleResizeUp],
  );

  return (
    <div
      data-testid="aichat-panel-floating"
      className="fixed z-[1100] flex flex-col bg-slate-900 border border-slate-600 rounded-lg shadow-2xl overflow-hidden"
      style={{ left: x, top: y, width: w, height: h }}
    >
      {/* Title bar */}
      <div
        onMouseDown={handleDragDown}
        className="flex items-center justify-between px-3 py-2 bg-slate-800 border-b border-slate-700 cursor-move flex-shrink-0"
      >
        <span className="text-xs font-semibold text-violet-400 uppercase tracking-wide">
          AI Chat
        </span>
        <div className="flex items-center gap-1">
          {onNewConversation && (
            <NewConversationButton onClick={onNewConversation} />
          )}
          <button
            onClick={onPin}
            title="Dock to right side"
            className="p-1 text-slate-400 hover:text-violet-300 hover:bg-slate-700 rounded transition"
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
            x
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden flex flex-col">
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

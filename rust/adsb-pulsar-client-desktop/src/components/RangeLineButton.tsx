"use client";

/** Receiver magenta — the receiver marker's colour, so a range line reads as "from the receiver". */
export const RANGE_LINE_COLOR = "#e91e90";

/** Tooltip shared by the map button and the details-panel toggle. */
export function rangeLineTitle({
  active,
  disabled = false,
  hasTargets = false,
}: {
  active: boolean;
  disabled?: boolean;
  hasTargets?: boolean;
}): string {
  if (disabled) return "No receiver location set";
  if (!active) return "Show range lines to selected aircraft";
  return hasTargets ? "Hide range lines" : "Range lines on: select an aircraft";
}

/** A dashed diagonal from a receiver dot to an end dot. */
export function RangeLineIcon({ size = 16, color = "#333" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="5" y1="19" x2="19" y2="5" strokeDasharray="3 3" />
      <circle cx="5" cy="19" r="2" fill={color} stroke="none" />
      <circle cx="19" cy="5" r="2.5" />
    </svg>
  );
}

interface Props {
  active: boolean;
  onToggle: () => void;
  /** No receiver location configured. */
  disabled?: boolean;
  /** At least one selected aircraft can be drawn to. Only changes the tooltip. */
  hasTargets?: boolean;
}

/** Map control under "Center on antenna": toggles the range-line mode. */
export function RangeLineButton({ active, onToggle, disabled = false, hasTargets = false }: Props) {
  const on = active && !disabled;
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={on}
      aria-label="Range lines to receiver"
      title={rangeLineTitle({ active, disabled, hasTargets })}
      className={`absolute top-20 right-2.5 z-[1000] w-8 h-8 rounded shadow-md border flex items-center justify-center transition disabled:opacity-40 disabled:cursor-not-allowed ${
        on
          ? "bg-pink-50 border-pink-400 hover:bg-pink-100"
          : "bg-white border-gray-300 hover:bg-gray-100 disabled:hover:bg-white"
      }`}
    >
      <RangeLineIcon color={on ? RANGE_LINE_COLOR : "#333"} />
    </button>
  );
}

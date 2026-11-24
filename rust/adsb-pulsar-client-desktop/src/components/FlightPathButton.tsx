"use client";

/** Amber: the colour the route path is drawn in on the map. */
export const FLIGHT_PATH_COLOR = "#f59e0b";

/** Tooltip shared by the map button and the details panel's eye. */
export function flightPathTitle({ active, hasRoute = false }: { active: boolean; hasRoute?: boolean }): string {
  if (!active) return "Show route on map";
  return hasRoute ? "Hide route on map" : "Route on map: look up a flight with Show Flight Infos";
}

/** A dashed arc between two airport dots. */
export function FlightPathIcon({ size = 16, color = "#333" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 18 Q12 2 20 18" strokeDasharray="3 3" />
      <circle cx="4" cy="18" r="2.5" />
      <circle cx="20" cy="18" r="2.5" />
    </svg>
  );
}

interface Props {
  active: boolean;
  onToggle: () => void;
  /** A looked-up route is being drawn. Only changes the tooltip. */
  hasRoute?: boolean;
}

/**
 * Map control between the range-line button and the light/dark toggle: shows
 * or hides the selected flight's route path. The same setting as the details
 * panel's eye, so it works before any route is looked up.
 */
export function FlightPathButton({ active, onToggle, hasRoute = false }: Props) {
  const title = flightPathTitle({ active, hasRoute });
  return (
    <button
      onClick={onToggle}
      aria-pressed={active}
      aria-label="Route on map"
      title={title}
      className={`absolute top-[7.25rem] right-2.5 z-[1000] w-8 h-8 rounded shadow-md border flex items-center justify-center transition ${
        active ? "bg-amber-50 border-amber-400 hover:bg-amber-100" : "bg-white border-gray-300 hover:bg-gray-100"
      }`}
    >
      <FlightPathIcon color={active ? FLIGHT_PATH_COLOR : "#333"} />
    </button>
  );
}

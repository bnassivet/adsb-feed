"use client";
import {
  EMPTY_SERVICE_VIEW,
  describeServiceStatus,
  describeValidity,
  levelLabel,
  serviceToggleView,
} from "@/lib/weather";
import type {
  ServiceTone,
  WeatherAvailability,
  WeatherLevel,
  WeatherServiceView,
} from "@/lib/weather";

const TONE_CLASS: Record<ServiceTone, string> = {
  ok: "text-slate-500",
  warn: "text-amber-400",
  error: "text-red-400",
};

export interface WeatherControlsProps {
  /** Whether the weather layer is drawn. */
  show: boolean;
  onToggle: () => void;
  /** The level whose winds the layer draws. */
  level: WeatherLevel;
  onLevelChange: (level: WeatherLevel) => void;
  /** Wind barbs at the grid points. */
  showBarbs: boolean;
  onToggleBarbs: () => void;
  /** Animated particles following the wind. */
  showParticles: boolean;
  onToggleParticles: () => void;
  /** Pressure levels in the held snapshot, lowest altitude first. */
  levels: number[];
  availability: WeatherAvailability;
  /** Valid time of the held snapshot, or null when there is none. */
  validTimeMs: number | null;
  stale: boolean;
  nowMs: number;
  /** Credit line the data licence requires, or null with no snapshot. */
  attribution: string | null;
  /** What the weather service last reported. */
  service?: WeatherServiceView;
  /** A setting sent to the service and not yet reported back. */
  pendingEnabled?: boolean | null;
  /** Why the last enable/disable did not take. */
  serviceError?: string | null;
  /** Sends enable/disable to the service. Without it there is no switch. */
  onServiceToggle?: (enabled: boolean) => void;
}

/** The weather layer's toggle, level picker and data status. */
export function WeatherControls({
  show,
  onToggle,
  level,
  onLevelChange,
  showBarbs,
  onToggleBarbs,
  showParticles,
  onToggleParticles,
  levels,
  availability,
  validTimeMs,
  stale,
  nowMs,
  attribution,
  service = EMPTY_SERVICE_VIEW,
  pendingEnabled = null,
  serviceError = null,
  onServiceToggle,
}: WeatherControlsProps) {
  const unsupported = availability === "unsupported_source";
  const options: WeatherLevel[] = ["surface", ...levels];
  const toggle = onServiceToggle ? serviceToggleView(availability, service, pendingEnabled) : null;
  const serviceLine = onServiceToggle ? describeServiceStatus(service, nowMs) : null;

  return (
    <div>
      <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={show}
          onChange={onToggle}
          disabled={unsupported}
          className="accent-sky-500"
        />
        <span>Winds aloft</span>
      </label>

      {unsupported && (
        <p className="ml-5 mt-1 text-[11px] text-slate-500">
          Weather arrives over MQTT. Set the live source to MQTT in Settings to receive it.
        </p>
      )}
      {availability === "waiting" && (
        <p className="ml-5 mt-1 text-[11px] text-slate-500">Waiting for the weather service…</p>
      )}

      {toggle && onServiceToggle && !unsupported && (
        <div className="ml-5 mt-1 flex flex-col gap-0.5">
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={toggle.checked}
              disabled={toggle.disabled}
              onChange={() => onServiceToggle(!toggle.checked)}
              className="accent-sky-500"
            />
            <span>Fetch weather</span>
            {toggle.pending && (
              <span className="text-[10px] text-slate-500">
                {toggle.checked ? "resuming…" : "pausing…"}
              </span>
            )}
          </label>
          {serviceLine && (
            <p className={`text-[11px] ${TONE_CLASS[serviceLine.tone]}`}>{serviceLine.text}</p>
          )}
          {!serviceLine && toggle.reason && (
            <p className="text-[11px] text-slate-500">{toggle.reason}</p>
          )}
          {serviceError && (
            <p role="alert" className="text-[11px] text-red-400">
              {serviceError}
            </p>
          )}
        </div>
      )}

      {show && !unsupported && (
        <div className="ml-5 mt-2 flex flex-col gap-2">
          <div role="group" aria-label="Wind level" className="flex flex-wrap gap-1">
            {options.map((option) => {
              const selected = option === level;
              return (
                <button
                  key={String(option)}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onLevelChange(option)}
                  className={`px-1.5 py-0.5 rounded border text-[10px] transition ${
                    selected
                      ? "bg-sky-600/40 border-sky-500 text-sky-100"
                      : "bg-slate-800 border-slate-600 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {levelLabel(option)}
                </button>
              );
            })}
          </div>

          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer select-none">
              <input type="checkbox" checked={showBarbs} onChange={onToggleBarbs} className="accent-sky-500" />
              <span>Barbs</span>
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showParticles}
                onChange={onToggleParticles}
                className="accent-sky-500"
              />
              <span>Particles</span>
            </label>
          </div>

          {validTimeMs != null && (
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <span>{describeValidity(validTimeMs, nowMs)}</span>
              {stale && (
                <span className="px-1 py-0.5 text-[9px] font-bold rounded bg-amber-800/60 text-amber-300 uppercase tracking-wide">
                  stale
                </span>
              )}
            </div>
          )}

          {attribution && <p className="text-[10px] text-slate-600">{attribution}</p>}
        </div>
      )}
    </div>
  );
}

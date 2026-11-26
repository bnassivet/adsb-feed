"use client";
import {
  areaCost,
  areaSqDeg,
  MAX_AREA_SQ_DEG,
  MAX_AREAS,
  type OpenSkyArea,
  type OpenSkyMode,
  type OpenSkyServiceView,
} from "@/lib/opensky";

export interface OpenSkyControlsProps {
  /** The layer switch: draws OpenSky aircraft and keeps the watch lease. */
  show: boolean;
  onToggle: () => void;
  mode: OpenSkyMode;
  onModeChange: (mode: OpenSkyMode) => void;
  areas: OpenSkyArea[];
  /** Starts drawing an area on the map; the pick lands in `areas`. */
  onDrawArea: () => void;
  onRemoveArea: (id: string) => void;
  /** Aircraft currently asked for (lowercase icao24). */
  watched: string[];
  /** OpenSky aircraft currently drawn. */
  shownCount: number;
  service: OpenSkyServiceView;
  pendingEnabled: boolean | null;
  serviceError: string | null;
  watchError: string | null;
  onServiceToggle: (enabled: boolean) => void;
  nowMs: number;
}

/** One line saying what the service is doing, in the user's terms. */
export function describeOpenSkyService(view: OpenSkyServiceView, nowMs: number): {
  text: string;
  tone: "ok" | "warn" | "error";
} | null {
  if (view.availability === "offline") {
    return { text: "OpenSky service offline", tone: "error" };
  }
  const s = view.status;
  if (!s) return null;
  switch (s.state) {
    case "idle":
      return { text: "Idle: nothing to watch, no credits spent", tone: "ok" };
    case "polling":
    case "waiting": {
      const every = s.interval_seconds ? ` every ${Math.round(s.interval_seconds)} s` : "";
      return { text: `Polling${every} (${s.cycle_cost} credit${s.cycle_cost === 1 ? "" : "s"} a poll)`, tone: "ok" };
    }
    case "retrying":
      return { text: `Retrying: ${s.last_error ?? "OpenSky unavailable"}`, tone: "warn" };
    case "rate_limited": {
      const mins = s.rate_limited_until_ms
        ? Math.max(1, Math.ceil((s.rate_limited_until_ms - nowMs) / 60_000))
        : null;
      return { text: `Rate limited by OpenSky${mins ? `, retry in ${mins} min` : ""}`, tone: "warn" };
    }
    case "unauthorized":
      return { text: "OpenSky refused the credentials ([opensky] client_id/secret)", tone: "error" };
    case "disabled":
      return { text: "Paused", tone: "warn" };
  }
}

const TONE_CLASS = { ok: "text-slate-500", warn: "text-amber-400", error: "text-red-400" };

export function OpenSkyControls(props: OpenSkyControlsProps) {
  const {
    show,
    onToggle,
    mode,
    onModeChange,
    areas,
    onDrawArea,
    onRemoveArea,
    watched,
    shownCount,
    service,
    pendingEnabled,
    serviceError,
    watchError,
    onServiceToggle,
    nowMs,
  } = props;
  const status = service.status;
  const line = describeOpenSkyService(service, nowMs);
  const enabled = pendingEnabled ?? status?.enabled ?? true;

  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <label className="flex items-center gap-2 text-slate-400 cursor-pointer select-none">
        <input type="checkbox" checked={show} onChange={onToggle} className="accent-violet-500" />
        <span>Fill gaps from OpenSky</span>
      </label>

      {show && (
        <div className="ml-5 flex flex-col gap-1.5">
          {!status && service.availability !== "offline" && (
            <p className="text-[11px] text-slate-500">
              Waiting for the OpenSky service ([opensky] enabled, live source MQTT)…
            </p>
          )}

          {status && (
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={enabled}
                disabled={pendingEnabled !== null || service.availability === "offline"}
                onChange={() => onServiceToggle(!enabled)}
                className="accent-violet-500"
              />
              <span>Poll OpenSky</span>
              {pendingEnabled !== null && (
                <span className="text-[10px] text-slate-500">{pendingEnabled ? "resuming…" : "pausing…"}</span>
              )}
            </label>
          )}
          {line && <p className={`text-[11px] ${TONE_CLASS[line.tone]}`}>{line.text}</p>}
          {status && !status.authenticated && (
            <p className="text-[11px] text-amber-400">Anonymous: 400 credits a day, no track backfill</p>
          )}
          {serviceError && (
            <p role="alert" className="text-[11px] text-red-400">{serviceError}</p>
          )}
          {watchError && (
            <p role="alert" className="text-[11px] text-red-400">{watchError}</p>
          )}

          <div role="group" aria-label="When to show OpenSky" className="flex gap-1">
            {(["gaps", "always"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => onModeChange(m)}
                className={`px-2 py-0.5 rounded border text-[11px] ${
                  mode === m
                    ? "bg-violet-600/30 border-violet-500 text-violet-200"
                    : "border-slate-600 text-slate-400 hover:text-slate-200"
                }`}
                title={
                  m === "gaps"
                    ? "Selected aircraft only while the receiver has lost them"
                    : "Selected aircraft from OpenSky beside the receiver's own"
                }
              >
                {m === "gaps" ? "Gaps only" : "Always"}
              </button>
            ))}
          </div>

          <p className="text-[11px] text-slate-500">
            {watched.length > 0
              ? `Following ${watched.length} selected aircraft`
              : "Select aircraft to follow them through gaps"}
            {shownCount > 0 && ` · ${shownCount} from OpenSky on the map`}
          </p>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-400">Areas</span>
              <button
                type="button"
                onClick={onDrawArea}
                disabled={areas.length >= MAX_AREAS}
                className="px-2 py-0.5 rounded border border-slate-600 text-[11px] text-slate-300 hover:text-white disabled:opacity-40"
              >
                Draw area
              </button>
            </div>
            {areas.length === 0 && (
              <p className="text-[11px] text-slate-500">None. Draw one over a blind sector.</p>
            )}
            <ul className="flex flex-col gap-0.5">
              {areas.map((a) => {
                const sq = areaSqDeg(a);
                const cost = areaCost(a);
                const tooLarge = sq > MAX_AREA_SQ_DEG;
                return (
                  <li key={a.id} className="flex items-center justify-between text-[11px]">
                    <span className={tooLarge ? "text-red-400" : cost > 1 ? "text-amber-400" : "text-slate-400"}>
                      {a.id} · {sq.toFixed(1)} sq° ·{" "}
                      {tooLarge ? "too large, refused" : `${cost} credit${cost === 1 ? "" : "s"}/poll`}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove area ${a.id}`}
                      onClick={() => onRemoveArea(a.id)}
                      className="text-slate-500 hover:text-red-400 px-1"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

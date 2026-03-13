"use client";
import { useEffect, useState } from "react";
import { getConfig, getStatus, saveConfig, validateConfig } from "@/lib/commands";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useDisplayTz } from "@/hooks/useDisplayTz";
import { TRACK_HISTORY_HOURS_KEY, DEFAULT_TRACK_HISTORY_HOURS } from "@/contexts/AircraftTrackingContext";
import type { Config } from "@/lib/types";
import Link from "next/link";

export default function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [trajectoryStyle, setTrajectoryStyle] = useLocalStorage<"line" | "dots">("adsb-trajectory-style", "line");
  const { tzMode, setTzMode } = useDisplayTz();
  const [metricsWindowSecs, setMetricsWindowSecs] = useLocalStorage<number>("adsb-metrics-window-secs", 5);
  const [trackHistoryHours, setTrackHistoryHours] = useLocalStorage<number>(TRACK_HISTORY_HOURS_KEY, DEFAULT_TRACK_HISTORY_HOURS);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch((e) =>
        setMessage({ type: "error", text: `Failed to load config: ${e}` }),
      );
  }, []);

  if (!config) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-950 text-slate-400">
        Loading configuration...
      </div>
    );
  }

  function update(partial: Partial<Config>) {
    setConfig((prev) => (prev ? { ...prev, ...partial } : prev));
  }

  async function handleValidate() {
    if (!config) return;
    try {
      await validateConfig(config);
      setMessage({ type: "success", text: "Configuration is valid" });
    } catch (e) {
      setMessage({ type: "error", text: String(e) });
    }
  }

  async function handleSave() {
    if (!config) return;
    try {
      await saveConfig(config);
      const status = await getStatus();
      const text = status.is_running
        ? "Configuration saved. Connection changes will apply on next restart."
        : "Configuration saved";
      setMessage({ type: "success", text });
    } catch (e) {
      setMessage({ type: "error", text: String(e) });
    }
  }

  return (
    <div className="h-screen bg-slate-950 overflow-y-auto">
      <div className="max-w-2xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold text-slate-200">Settings</h1>
          <Link
            href="/"
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded transition"
          >
            Back to Dashboard
          </Link>
        </div>

        {message && (
          <div
            className={`mb-4 px-4 py-2 rounded text-sm ${
              message.type === "success"
                ? "bg-green-900/50 text-green-300 border border-green-700"
                : "bg-red-900/50 text-red-300 border border-red-700"
            }`}
          >
            {message.text}
          </div>
        )}

        <div className="space-y-6">
          {/* Basic settings */}
          <section className="bg-slate-900 rounded-lg p-4 border border-slate-800">
            <h2 className="text-sm font-semibold text-slate-300 mb-4">
              Connection
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Source ID" value={config.source_id} onChange={(v) => update({ source_id: v })} />
              <Field label="Socket Host" value={config.socket_host} onChange={(v) => update({ socket_host: v })} />
              <Field label="Socket Port" type="number" value={String(config.socket_port)} onChange={(v) => update({ socket_port: Number(v) })} />
              <Field label="Connection Mode" value={config.connection_mode} onChange={(v) => update({ connection_mode: v })} />
              <div className="col-span-2">
                <Field
                  label="Source Timezone"
                  value={config.dump1090_tz}
                  onChange={(v) => update({ dump1090_tz: v })}
                />
                <p className="text-xs text-slate-500 mt-1">
                  Timezone of dump1090 timestamps. Use{" "}
                  <code className="text-slate-400">Local</code>,{" "}
                  <code className="text-slate-400">UTC</code>, or an IANA name like{" "}
                  <code className="text-slate-400">Europe/Paris</code>.
                </p>
              </div>
            </div>
          </section>

          {/* Receiver Location */}
          <section className="bg-slate-900 rounded-lg p-4 border border-slate-800">
            <h2 className="text-sm font-semibold text-slate-300 mb-4">
              Receiver Location
            </h2>
            <div className="grid grid-cols-3 gap-4">
              <Field
                label="Latitude"
                type="number"
                value={config.receiver_latitude != null ? String(config.receiver_latitude) : ""}
                onChange={(v) => {
                  const n = parseFloat(v);
                  update({ receiver_latitude: isNaN(n) ? null : n });
                }}
              />
              <Field
                label="Longitude"
                type="number"
                value={config.receiver_longitude != null ? String(config.receiver_longitude) : ""}
                onChange={(v) => {
                  const n = parseFloat(v);
                  update({ receiver_longitude: isNaN(n) ? null : n });
                }}
              />
              <Field
                label="Altitude (ft)"
                type="number"
                value={config.receiver_altitude != null ? String(config.receiver_altitude) : ""}
                onChange={(v) => {
                  const n = parseFloat(v);
                  update({ receiver_altitude: isNaN(n) ? null : n });
                }}
              />
            </div>
            <p className="text-xs text-slate-500 mt-2">
              Physical location of your ADS-B receiver antenna. Used as map center and for distance calculations.
            </p>
          </section>

          <section className="bg-slate-900 rounded-lg p-4 border border-slate-800">
            <h2 className="text-sm font-semibold text-slate-300 mb-4">
              Pulsar
            </h2>
            <div className="grid grid-cols-1 gap-4">
              <Field label="Broker URL" value={config.pulsar_broker} onChange={(v) => update({ pulsar_broker: v })} />
              <Field label="Topic" value={config.pulsar_topic} onChange={(v) => update({ pulsar_topic: v })} />
            </div>
            <div className="mt-4 flex items-center gap-2">
              <input
                type="checkbox"
                id="test_mode"
                checked={config.test_mode}
                onChange={(e) => update({ test_mode: e.target.checked })}
                className="accent-blue-500"
              />
              <label htmlFor="test_mode" className="text-sm text-slate-300">
                Test mode (no Pulsar connection)
              </label>
            </div>
          </section>

          {/* Display settings (UI-only, stored in localStorage) */}
          <section className="bg-slate-900 rounded-lg p-4 border border-slate-800">
            <h2 className="text-sm font-semibold text-slate-300 mb-4">
              Display
            </h2>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Trajectory Style</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setTrajectoryStyle("line")}
                  className={`px-3 py-1.5 text-sm rounded transition ${
                    trajectoryStyle === "line"
                      ? "bg-blue-600 text-white"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  Lines
                </button>
                <button
                  onClick={() => setTrajectoryStyle("dots")}
                  className={`px-3 py-1.5 text-sm rounded transition ${
                    trajectoryStyle === "dots"
                      ? "bg-blue-600 text-white"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  Dots
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-2">
                How aircraft trajectories are drawn on the map. Saved automatically.
              </p>
            </div>
            <div className="mt-4">
              <label className="block text-xs text-slate-400 mb-1">Time Display</label>
              <div className="flex gap-2">
                {(["local", "utc", "source"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setTzMode(mode)}
                    className={`px-3 py-1.5 text-sm rounded capitalize transition ${
                      tzMode === mode
                        ? "bg-blue-600 text-white"
                        : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                    }`}
                  >
                    {mode === "source" ? "Source" : mode === "utc" ? "UTC" : "Local"}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-2">
                Timezone for displaying stored timestamps. &ldquo;Source&rdquo; uses the
                Source Timezone above. Saved automatically.
              </p>
            </div>
            <div className="mt-4">
              <Field
                label="Throughput Window (s)"
                type="number"
                value={String(metricsWindowSecs)}
                onChange={(v) => {
                  const n = parseInt(v, 10);
                  if (!isNaN(n) && n >= 1 && n <= 60) setMetricsWindowSecs(n);
                }}
              />
              <p className="text-xs text-slate-500 mt-1">
                Sliding window for msgs/s calculation (1&ndash;60s). Saved automatically.
              </p>
            </div>
            <div className="mt-4">
              <label className="block text-xs text-slate-400 mb-1">Track History ({trackHistoryHours}h)</label>
              <input
                type="range"
                min={1}
                max={72}
                step={1}
                value={trackHistoryHours}
                onChange={(e) => setTrackHistoryHours(Number(e.target.value))}
                className="w-full accent-blue-500"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>1h</span>
                <span>72h</span>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                How long expired tracks are kept in history before being pruned. Also controls
                the startup DuckDB history load window. Saved automatically.
              </p>
            </div>
          </section>

          {/* Advanced settings (collapsible) */}
          <section className="bg-slate-900 rounded-lg border border-slate-800">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold text-slate-300 hover:bg-slate-800/50 transition"
            >
              <span>Advanced</span>
              <span>{showAdvanced ? "\u25B2" : "\u25BC"}</span>
            </button>
            {showAdvanced && (
              <div className="px-4 pb-4 grid grid-cols-2 gap-4">
                <Field label="Recv Buffer Size" type="number" value={String(config.recv_buffer_size)} onChange={(v) => update({ recv_buffer_size: Number(v) })} />
                <Field label="Socket Timeout (s)" type="number" value={String(config.socket_timeout_secs)} onChange={(v) => update({ socket_timeout_secs: Number(v) })} />
                <Field label="Read Timeout (s)" type="number" value={String(config.socket_read_timeout_secs)} onChange={(v) => update({ socket_read_timeout_secs: Number(v) })} />
                <Field label="Initial Retry Delay (s)" type="number" value={String(config.initial_retry_delay_secs)} onChange={(v) => update({ initial_retry_delay_secs: Number(v) })} />
                <Field label="Max Retry Delay (s)" type="number" value={String(config.max_retry_delay_secs)} onChange={(v) => update({ max_retry_delay_secs: Number(v) })} />
                <Field label="Log Sample Rate" type="number" value={String(config.log_sample_rate)} onChange={(v) => update({ log_sample_rate: Number(v) })} />
                <Field label="Max Retry Queue" type="number" value={String(config.max_retry_queue_size)} onChange={(v) => update({ max_retry_queue_size: Number(v) })} />
                <Field label="Max Line Buffer" type="number" value={String(config.max_line_buffer_size)} onChange={(v) => update({ max_line_buffer_size: Number(v) })} />
                <Field label="Batch Delay (ms)" type="number" value={String(config.pulsar_batch_delay_ms)} onChange={(v) => update({ pulsar_batch_delay_ms: Number(v) })} />
                <Field label="Batch Max Messages" type="number" value={String(config.pulsar_batch_max_messages)} onChange={(v) => update({ pulsar_batch_max_messages: Number(v) })} />
                <Field label="Log Level" value={config.log_level} onChange={(v) => update({ log_level: v })} />
              </div>
            )}
          </section>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={handleValidate}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded transition"
            >
              Validate
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-slate-200 focus:border-blue-500 focus:outline-none"
      />
    </div>
  );
}

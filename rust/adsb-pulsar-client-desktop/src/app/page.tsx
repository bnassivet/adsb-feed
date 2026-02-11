"use client";
import { useState } from "react";
import { Map } from "@/components/Map";
import { AircraftTable } from "@/components/AircraftTable";
import { MetricsBar } from "@/components/MetricsBar";
import { ConnectionStatusIndicator } from "@/components/ConnectionStatus";
import { FiltersPanel } from "@/components/Filters";
import { useAircraftTracks } from "@/hooks/useAircraftTracks";
import { useMetrics } from "@/hooks/useMetrics";
import { useConnectionStatus } from "@/hooks/useConnectionStatus";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { startFeed, stopFeed } from "@/lib/commands";
import { DEFAULT_FILTERS } from "@/lib/types";
import type { Filters } from "@/lib/types";
import Link from "next/link";

export default function Dashboard() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const tracks = useAircraftTracks(filters);
  const metrics = useMetrics();
  const status = useConnectionStatus();

  // Listen for stopped event to sync local state
  useTauriEvent("adsb:stopped", () => setIsRunning(false));

  async function handleStart() {
    try {
      setError(null);
      await startFeed();
      setIsRunning(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleStop() {
    try {
      setError(null);
      await stopFeed();
      setIsRunning(false);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Header bar */}
      <header className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-700">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-semibold text-slate-200">
            ADS-B Aircraft Tracker
          </h1>
          <ConnectionStatusIndicator
            label="Socket"
            status={status.socket_status}
          />
          <ConnectionStatusIndicator
            label="Pulsar"
            status={status.pulsar_status}
          />
        </div>
        <div className="flex items-center gap-3">
          {error && (
            <span className="text-xs text-red-400 max-w-xs truncate">
              {error}
            </span>
          )}
          {isRunning ? (
            <button
              onClick={handleStop}
              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded transition"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleStart}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition"
            >
              Start
            </button>
          )}
          <Link
            href="/settings"
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded transition"
          >
            Settings
          </Link>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-56 bg-slate-900 border-r border-slate-700 overflow-y-auto flex-shrink-0">
          <FiltersPanel
            filters={filters}
            onChange={setFilters}
            trackCount={tracks.length}
          />
        </aside>

        {/* Map + Table */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Map */}
          <div className="flex-1 min-h-0">
            <Map tracks={tracks} />
          </div>

          {/* Table */}
          <div className="border-t border-slate-700 bg-slate-900">
            <AircraftTable tracks={tracks} />
          </div>
        </main>
      </div>

      {/* Footer metrics */}
      <MetricsBar metrics={metrics} />
    </div>
  );
}

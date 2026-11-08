"use client";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { tileConfig } from "@/lib/basemap";
import { formatBytes } from "@/lib/format";
import { locateTileCache, type DatabaseLocation } from "@/lib/commands";
import { formatCoverage } from "@/lib/tile-cache/coverage";
import { estimateTiles } from "@/lib/tile-cache/geometry";
import type { TileProvider } from "@/lib/tile-cache/keys";
import { recordStoreFailure, resetStoreHealth, storeHealth, subscribeStoreHealth } from "@/lib/tile-cache/health";
import type { PrefetchProgress } from "@/lib/tile-cache/prefetch";
import {
  cancelPrefetchJob,
  prefetchJob,
  startPrefetchJob,
  subscribePrefetchJob,
  type PrefetchJobState,
} from "@/lib/tile-cache/prefetchJob";
import { TILE_CACHE_LIMITS, validateTileCacheSettings } from "@/lib/tile-cache/settings";
import { sharedTileStore } from "@/lib/tile-cache/shared";
import type { TileCacheStats, TileStore, ZoomCoverage } from "@/lib/tile-cache/store";
import { useTileCacheSettings } from "@/hooks/useTileCacheSettings";

const PROVIDER_LABELS: Record<TileProvider, string> = {
  osm: "OpenStreetMap",
  "esri-dark": "Esri Dark Gray",
  "carto-dark": "CARTO Dark Matter",
};

const MB = 1024 * 1024;

interface Props {
  /** Receiver location from the config; null when not set. */
  receiver: { lat: number; lon: number } | null;
  /** Injected for tests; the app uses the window's shared store. */
  openStore?: () => Promise<TileStore | null>;
  /** Whether CARTO is configured, which adds it as a download source. */
  cartoApiKey: string | undefined;
  /** Injected for tests; finds the database on disk via the Tauri backend. */
  locate?: (dbName: string) => Promise<DatabaseLocation>;
}

/** `undefined` while looking, `null` when the lookup itself failed (e.g. outside Tauri). */
type LocationState = DatabaseLocation | null | undefined;

type Notice = { type: "success" | "error"; text: string } | null;

function tileCount(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "tile" : "tiles"}`;
}

/** Leaflet's own retina test: tiles fetched for prefetch must match what the map will ask for. */
function isRetina(): boolean {
  return typeof window !== "undefined" && (window.devicePixelRatio ?? 1) > 1;
}

/**
 * Settings → Map Tile Cache: size and contents, the footprint controls,
 * Clear, and the opt-in "Download area" prefetch.
 *
 * Settings apply on Apply (not per keystroke) because applying prunes the
 * store: typing "1" on the way to "150" must not delete everything beyond 1 NM.
 */
export function TileCacheSection({ receiver, openStore = sharedTileStore, cartoApiKey, locate = locateTileCache }: Props) {
  const [settings, saveSettings] = useTileCacheSettings();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [radius, setRadius] = useState(String(settings.radiusNm));
  const [maxSize, setMaxSize] = useState(String(settings.maxSizeMb));
  const [zoom, setZoom] = useState(String(settings.prefetchMaxZoom));

  const [store, setStore] = useState<TileStore | null | undefined>(undefined);
  const [stats, setStats] = useState<TileCacheStats | null>(null);
  const [quota, setQuota] = useState<{ usage?: number; quota?: number; persisted?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [location, setLocation] = useState<LocationState>(undefined);
  const [copied, setCopied] = useState(false);
  const health = useSyncExternalStore(subscribeStoreHealth, storeHealth, storeHealth);

  const providers = useMemo<TileProvider[]>(
    () => (cartoApiKey ? ["esri-dark", "carto-dark"] : ["esri-dark"]),
    [cartoApiKey],
  );
  const [provider, setProvider] = useState<TileProvider>("esri-dark");
  // The download outlives this component: it is the window's job, not page state.
  const job = useSyncExternalStore(subscribePrefetchJob, prefetchJob, prefetchJob);
  // `running`, not `progress.status`: progress is null until the first report,
  // and Cancel must be there while the very first tiles hang.
  const downloading = job?.running ?? false;
  const progress = job?.progress ?? null;

  const refresh = useCallback(
    async (s: TileStore | null) => {
      if (s) {
        // The file only exists once a tile has been stored, so look again on every refresh.
        locate(s.name).then(setLocation, () => setLocation(null));
        setStats(await s.stats());
      }
      const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
      if (storage?.estimate) {
        const [est, persisted] = await Promise.all([
          storage.estimate(),
          storage.persisted ? storage.persisted() : Promise.resolve(undefined),
        ]);
        setQuota({ usage: est.usage, quota: est.quota, persisted });
      }
    },
    [locate],
  );

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
    } catch {
      // Clipboard denied: the path is selectable text anyway.
    }
  }

  useEffect(() => {
    let live = true;
    openStore()
      .then(async (s) => {
        if (!live) return;
        setStore(s);
        await refresh(s);
      })
      .catch(() => live && setStore(null));
    return () => {
      live = false;
    };
  }, [openStore, refresh]);

  // A run ending changes the stats. One that ended before this page opened is
  // covered by the refresh on mount.
  useEffect(() => {
    if (!store) return;
    let wasRunning = prefetchJob()?.running ?? false;
    return subscribePrefetchJob(() => {
      const running = prefetchJob()?.running ?? false;
      if (wasRunning && !running) void refresh(store);
      wasRunning = running;
    });
  }, [store, refresh]);

  // Offline readiness of the saved footprint, for the provider picked below.
  // Recomputed whenever the stats change (a download, Apply, Clear).
  const [coverage, setCoverage] = useState<ZoomCoverage[] | null>(null);
  useEffect(() => {
    if (!store || !receiver || !stats) return;
    let live = true;
    store
      .coverage(provider, isRetina(), receiver.lat, receiver.lon, settings.radiusNm, settings.prefetchMaxZoom)
      .then((c) => live && setCoverage(c))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [store, receiver, stats, provider, settings.radiusNm, settings.prefetchMaxZoom]);

  const draftRadius = Number(radius);
  const draftZoom = Number(zoom);
  const estimate = useMemo(() => {
    if (!receiver) return null;
    const { radiusNm, prefetchMaxZoom } = TILE_CACHE_LIMITS;
    if (!(draftRadius >= radiusNm.min && draftRadius <= radiusNm.max)) return null;
    if (!(Number.isInteger(draftZoom) && draftZoom >= prefetchMaxZoom.min && draftZoom <= prefetchMaxZoom.max)) return null;
    return estimateTiles(receiver.lat, receiver.lon, draftRadius, draftZoom);
  }, [receiver, draftRadius, draftZoom]);

  async function apply() {
    const next = {
      enabled,
      radiusNm: Number(radius),
      maxSizeMb: Number(maxSize),
      prefetchMaxZoom: Number(zoom),
    };
    const problems = validateTileCacheSettings(next);
    setErrors(problems);
    setNotice(null);
    if (problems.length > 0) return;
    saveSettings(next);
    if (!store) return;
    setBusy(true);
    try {
      const pruned = receiver ? await store.pruneOutside(receiver.lat, receiver.lon, next.radiusNm) : 0;
      const evicted = await store.evictTo(next.maxSizeMb * MB);
      const removed = pruned + evicted;
      setNotice({
        type: "success",
        text: removed > 0 ? `Applied. Removed ${tileCount(removed)} outside the new limits.` : "Applied.",
      });
      await refresh(store);
    } catch (e) {
      setErrors([String(e)]);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!store) return;
    setBusy(true);
    setConfirmClear(false);
    try {
      await store.clear();
      resetStoreHealth();
      setNotice({ type: "success", text: "Tile cache cleared." });
      await refresh(store);
    } catch (e) {
      setErrors([String(e)]);
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (!store || !receiver) return;
    setNotice(null);
    setErrors([]);
    const tile = tileConfig("dark", provider === "carto-dark" ? cartoApiKey : undefined);
    try {
      await startPrefetchJob({
        store,
        tile,
        lat: receiver.lat,
        lon: receiver.lon,
        radiusNm: settings.radiusNm,
        maxZoom: settings.prefetchMaxZoom,
        retina: isRetina(),
        maxBytes: settings.maxSizeMb * MB,
        onStoreError: recordStoreFailure,
      });
    } catch {
      // Recorded on the job (job.error) and shown from there.
    }
  }


  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const capBytes = settings.maxSizeMb * MB;
  const usedPercent = stats ? Math.min(100, (stats.bytes / capBytes) * 100) : 0;
  // What the webview would let this cache grow to: its quota, less what the
  // rest of the app's storage already uses.
  const reachable =
    quota?.quota != null && stats ? quota.quota - Math.max(0, (quota.usage ?? 0) - stats.bytes) : null;

  return (
    <section className="bg-slate-900 rounded-lg p-4 border border-slate-800">
      <h2 className="text-sm font-semibold text-slate-300 mb-4">Map Tile Cache</h2>
      <p className="text-xs text-slate-500 mb-4">
        Basemap tiles within the footprint around the receiver are kept on this computer, so the map loads
        fast and works offline. Stored by the app&apos;s webview, which may clear it if the disk runs low.
      </p>

      {store === null ? (
        <p className="text-xs text-amber-400">The tile cache is unavailable in this window (no IndexedDB).</p>
      ) : (
        <div className="mb-4">
          <div className="flex justify-between text-sm text-slate-300">
            <span>
              {stats ? formatBytes(stats.bytes) : "…"} of {settings.maxSizeMb} MB
            </span>
            <span className="text-slate-400">{stats ? `${tileCount(stats.tiles)} cached` : ""}</span>
          </div>
          <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
            <div className="h-full bg-blue-600" style={{ width: `${usedPercent}%` }} />
          </div>
          {stats && stats.pinned.tiles > 0 && (
            <p className="mt-2 text-xs text-slate-400">
              Downloaded for offline use: {formatBytes(stats.pinned.bytes)} · {tileCount(stats.pinned.tiles)}. Kept
              until browsed tiles are gone when the cache is full.
            </p>
          )}
          {stats && Object.keys(stats.perProvider).length > 0 && (
            <ul className="mt-2 text-xs text-slate-500">
              {(Object.entries(stats.perProvider) as [TileProvider, { bytes: number; tiles: number }][]).map(
                ([p, s]) => (
                  <li key={p}>
                    {PROVIDER_LABELS[p] ?? p}: {formatBytes(s.bytes)} · {tileCount(s.tiles)}
                  </li>
                ),
              )}
            </ul>
          )}
          {store && (
            <div className="mt-3 text-xs text-slate-500">
              <div className="flex items-center justify-between gap-2">
                <span>
                  Location: IndexedDB database <code className="text-slate-400">{store.name}</code>
                </span>
                {location?.path && (
                  <button
                    type="button"
                    onClick={() => copyPath(location.path!)}
                    className="shrink-0 px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition"
                  >
                    {copied ? "Copied" : "Copy path"}
                  </button>
                )}
              </div>
              {location?.path ? (
                <code className="mt-1 block select-all break-all rounded bg-slate-950 px-2 py-1 text-slate-300">
                  {location.path}
                </code>
              ) : location === null ? (
                <p className="mt-1">Path unavailable outside the desktop app.</p>
              ) : location ? (
                <p className="mt-1">Not on disk yet: the webview creates it when the first tile is stored.</p>
              ) : null}
              <p className="mt-1">
                Managed by the webview: use Clear cache rather than deleting these files while the app is running.
              </p>
            </div>
          )}
          {quota?.quota != null && (
            <p className="mt-1 text-xs text-slate-500">
              Webview storage: {formatBytes(quota.usage ?? 0)} used of {formatBytes(quota.quota)} allowed
              {quota.persisted != null && ` · persistent: ${quota.persisted ? "yes" : "no"}`}
            </p>
          )}
          {reachable != null && capBytes > reachable && (
            <p className="mt-1 text-xs text-amber-400">
              The webview lets the cache grow to about {formatBytes(reachable)}, so the cap of {settings.maxSizeMb} MB
              cannot be reached: tiles beyond that will fail to store. Lower the cap or free disk space.
            </p>
          )}
          {health.failures > 0 && health.last && (
            <p className="mt-1 text-xs text-amber-400">
              {tileCount(health.failures)} could not be stored since the app started (last: {health.last.name}:{" "}
              {health.last.message}). They show on the map but are not available offline.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 mb-3">
        <input
          type="checkbox"
          id="tile_cache_enabled"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="accent-blue-500"
        />
        <label htmlFor="tile_cache_enabled" className="text-sm text-slate-300">
          Cache tiles as the map loads them
        </label>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <NumberField id="tile_cache_radius" label="Radius (NM)" value={radius} onChange={setRadius} />
        <NumberField id="tile_cache_size" label="Max size (MB)" value={maxSize} onChange={setMaxSize} />
        <NumberField id="tile_cache_zoom" label="Prefetch max zoom" value={zoom} onChange={setZoom} />
      </div>
      <p className="text-xs text-slate-500 mt-2">
        {estimate
          ? `Download area: ≈ ${estimate.count.toLocaleString()} tiles, ≈ ${formatBytes(estimate.bytes)} at this radius and zoom. Each extra zoom level is about 4× more.`
          : "Each extra zoom level is about 4× more tiles."}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={busy || downloading}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition disabled:opacity-50"
        >
          Apply
        </button>
        {confirmClear ? (
          <>
            <button
              type="button"
              onClick={clear}
              disabled={busy || downloading}
              className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-sm rounded transition disabled:opacity-50"
            >
              Confirm clear
            </button>
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded transition"
            >
              Keep tiles
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            disabled={busy || downloading || !store}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded transition disabled:opacity-50"
          >
            Clear cache
          </button>
        )}
      </div>

      <div className="mt-4 border-t border-slate-800 pt-4">
        <div className="flex items-end gap-2">
          <div>
            <label htmlFor="tile_cache_provider" className="block text-xs text-slate-400 mb-1">
              Download from
            </label>
            <select
              id="tile_cache_provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as TileProvider)}
              disabled={downloading}
              className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-slate-200"
            >
              {providers.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          {downloading ? (
            <button
              type="button"
              onClick={cancelPrefetchJob}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded transition"
            >
              Cancel download
            </button>
          ) : (
            <button
              type="button"
              onClick={download}
              disabled={busy || !store || !receiver}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded transition disabled:opacity-50"
            >
              Download area
            </button>
          )}
        </div>
        {receiver && coverage && (
          <p className="text-xs text-slate-400 mt-2">
            Offline coverage ({PROVIDER_LABELS[provider]}): {formatCoverage(coverage)}
          </p>
        )}
        {progress && (
          <div className="mt-2">
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-1.5 rounded bg-slate-800 overflow-hidden"
            >
              <div className="h-full bg-emerald-600" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} tiles
              {downloading && " · runs in the background: leaving Settings does not stop it, closing the app does"}
            </p>
          </div>
        )}
        <p className="text-xs text-slate-500 mt-2">
          {receiver
            ? `Fetches the ${settings.radiusNm} NM footprint up to zoom ${settings.prefetchMaxZoom}, coarse zooms first, and stops at the size cap. OpenStreetMap is not offered: its tile policy forbids bulk downloads, though tiles you view are still cached.`
            : "Set the receiver location above (and save) to download the area around it."}
        </p>
      </div>

      {job && !job.running && <JobOutcome job={job} maxSizeMb={settings.maxSizeMb} />}
      {notice && (
        <p className={`text-xs mt-3 ${notice.type === "success" ? "text-green-400" : "text-amber-400"}`}>{notice.text}</p>
      )}
      {errors.length > 0 && (
        <p className="text-xs text-red-400 mt-3" role="alert">
          {errors.join(". ")}
        </p>
      )}
    </section>
  );
}

/** What the last download ended with: done, stopped and why, or refused. */
function JobOutcome({ job, maxSizeMb }: { job: PrefetchJobState; maxSizeMb: number }) {
  if (job.error) {
    return (
      <p className="text-xs text-red-400 mt-3" role="alert">
        {job.error}
      </p>
    );
  }
  const result: PrefetchProgress | null = job.progress;
  if (!result) return null;
  const summary = `${tileCount(result.fetched)} downloaded (${formatBytes(result.bytes)})${
    result.failed ? `, ${result.failed} failed` : ""
  }.`;
  const text = {
    complete: result.failed
      ? `Download finished with ${result.failed} failed ${result.failed === 1 ? "tile" : "tiles"}: those are not available offline. Run it again to retry them. ${summary}`
      : `Download complete: ${summary}`,
    cancelled: `Download cancelled: ${summary}`,
    "cap-reached": `Stopped at the ${maxSizeMb} MB size cap: ${summary} Raise the cap or lower the zoom.`,
    "storage-full": `Stopped: the webview refused to store more tiles (out of space). ${summary} Free disk space, or lower the zoom or radius.`,
    placeholder: `Stopped: ${PROVIDER_LABELS[job.provider]} answered with its "API key required" image, so the key is missing or invalid. Nothing from it was stored.`,
    running: summary,
  }[result.status];
  const ok = result.status === "complete" && !result.failed;
  return <p className={`text-xs mt-3 ${ok ? "text-green-400" : "text-amber-400"}`}>{text}</p>;
}

function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-slate-400 mb-1">
        {label}
      </label>
      <input
        id={id}
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-slate-200 focus:border-blue-500 focus:outline-none"
      />
    </div>
  );
}

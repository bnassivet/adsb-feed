"use client";
import { useEffect, useRef, useState } from "react";
import { getWeatherAt, getWeatherHistory } from "@/lib/commands";
import { STALE_AFTER_MS, type WeatherSnapshot } from "@/lib/weather";
import {
  lruGet,
  lruPut,
  nearestSnapshotTime,
  parseRecordedSnapshot,
  type HistoricalWeatherEntry,
} from "@/lib/weather-history";

/** Why a slot holds no entry, or that it does. */
export type HistoricalWeatherStatus = "idle" | "loading" | "found" | "none" | "unavailable";

export interface HistoricalWeatherSlot {
  entry: HistoricalWeatherEntry | null;
  status: HistoricalWeatherStatus;
  /** Why nothing could be looked up — e.g. `"Storage not available"`. */
  error: string | null;
}

export interface HistoricalWeather {
  /** The hour the map draws: the browsed window's end. */
  map: HistoricalWeatherSlot;
  /** The hour a selected aircraft's wind is read from: its own `last_seen`. */
  aircraft: HistoricalWeatherSlot;
}

const IDLE: HistoricalWeatherSlot = { entry: null, status: "idle", error: null };

/** Eight snapshots at ~16 KB each — bounded, because a week of browsing is not. */
const CACHE_CAP = 8;

/**
 * How far either side to look, and how far is still "near enough".
 *
 * The same span as staleness for the same physical reason: the model refreshes
 * hourly, so an hour further away than this describes different weather.
 */
const WINDOW_MS = STALE_AFTER_MS;

type SnapshotCache = { current: Map<number, WeatherSnapshot> };

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Fetches one payload and caches it by its model hour. */
async function loadSnapshot(
  validTimeMs: number,
  cache: SnapshotCache,
): Promise<WeatherSnapshot | null> {
  const row = await getWeatherAt({ valid_time_ms: validTimeMs, source_id: null });
  if (!row) return null;
  const parsed = parseRecordedSnapshot(row);
  if (parsed) lruPut(cache.current, validTimeMs, parsed, CACHE_CAP);
  return parsed;
}

/**
 * One time in, one slot out.
 *
 * Used twice rather than folded into a single effect, so the two slots are
 * independent by construction and each dependency stays a scalar — an array
 * dependency would need a value-derived signature to avoid re-firing on
 * identity alone.
 */
function useSlot(timeMs: number | null, cache: SnapshotCache): HistoricalWeatherSlot {
  const [slot, setSlot] = useState<HistoricalWeatherSlot>(IDLE);
  const requestIdRef = useRef(0);

  useEffect(() => {
    // Bumped in the effect BODY, never inside a setState updater. StrictMode
    // double-invokes effects and keeps the second pass; a ref read-and-cleared
    // inside an updater is how `useTrajectoryPlayback`'s auto-start silently
    // died in the real app while every non-Strict test passed.
    const id = ++requestIdRef.current;
    let cancelled = false;
    const current = () => !cancelled && id === requestIdRef.current;

    if (timeMs === null) {
      setSlot(IDLE);
      return;
    }

    // Keep any entry already held while the next one is looked up, so the
    // layer does not blink on every browse.
    setSlot((prev) => (prev.status === "loading" ? prev : { ...prev, status: "loading" }));

    void (async () => {
      try {
        // Cheap hop first: metadata only, so this costs bytes rather than the
        // ~16 KB a payload would.
        const metas = await getWeatherHistory({
          start_ms: timeMs - WINDOW_MS,
          end_ms: timeMs + WINDOW_MS,
          limit: 24,
        });
        if (!current()) return;

        const validTimeMs = nearestSnapshotTime(metas, timeMs, WINDOW_MS);
        if (validTimeMs === null) {
          setSlot({ entry: null, status: "none", error: null });
          return;
        }

        // Keyed by the model hour, not by what was asked for: many requested
        // times resolve onto one hour, and both slots share this cache.
        const held = lruGet(cache.current, validTimeMs);
        const snapshot = held ?? (await loadSnapshot(validTimeMs, cache));
        // `invoke` is not abortable, so a superseded answer is dropped on
        // arrival rather than cancelled in flight.
        if (!current()) return;

        if (!snapshot) {
          // Absent and unparseable are one state: "no weather recorded here".
          setSlot({ entry: null, status: "none", error: null });
          return;
        }

        setSlot({
          entry: {
            snapshot,
            validTimeMs,
            requestedMs: timeMs,
            offsetMs: Math.abs(validTimeMs - timeMs),
          },
          status: "found",
          error: null,
        });
      } catch (error) {
        if (!current()) return;
        setSlot({ entry: null, status: "unavailable", error: messageOf(error) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [timeMs, cache]);

  return slot;
}

/**
 * The recorded weather for the time being viewed.
 *
 * Deliberately a sibling of `useWeatherSnapshot` rather than an extension of
 * it. That hook is a *control-plane* hook — four of its five state atoms are
 * about the MQTT weather service — and it owns two subtle mechanisms (the
 * availability race, and a CQRS confirm cleared during render). The sourcing
 * models here are its opposite: pull, keyed by a time that changes as the user
 * browses, cached and cancellable. Keeping them apart is what makes "the live
 * path did not regress" trivially true.
 *
 * This hook never subscribes to `adsb:weather`. A live snapshot arriving while
 * the user browses history must change nothing on screen, and the caller
 * selects on *mode* rather than on whichever value happens to be non-null.
 */
export function useHistoricalWeather(
  mapTimeMs: number | null,
  aircraftTimeMs: number | null,
): HistoricalWeather {
  const cache = useRef(new Map<number, WeatherSnapshot>());
  const map = useSlot(mapTimeMs, cache);
  const aircraft = useSlot(aircraftTimeMs, cache);
  return { map, aircraft };
}

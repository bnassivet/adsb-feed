import { StrictMode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { clearMockResponses, mockInvokeResponse } from "@/test/mocks/tauri";
import { useHistoricalWeather } from "../useHistoricalWeather";
import type { WeatherSnapshot, WindFields } from "@/lib/weather";
import type { WeatherSnapshotMeta, WeatherSnapshotRecord } from "@/lib/types";

const HOUR = 3_600_000;
const BASE = 1_789_412_400_000;

function uniform(dir: number, speed: number, n = 4): WindFields {
  return { wind_dir_deg: Array(n).fill(dir), wind_speed_kt: Array(n).fill(speed) };
}

function snapshot(validTimeMs: number, dir = 270): WeatherSnapshot {
  return {
    version: 1,
    source: "open-meteo",
    attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
    model: "best_match",
    fetched_at_ms: validTimeMs,
    valid_time_ms: validTimeMs,
    grid: { lat0: 46, lon0: -3, dlat: 1, dlon: 1, nlat: 2, nlon: 2 },
    surface: { ...uniform(dir, 10), mslp_hpa: [1013, 1013, 1013, 1013] },
    levels: { "850": uniform(dir, 20) },
  };
}

const columns = {
  source_id: "desktop",
  fetched_at_ms: BASE,
  received_at_ms: BASE,
  source: "open-meteo",
  model: "best_match",
  version: 1,
  lat0: 46,
  lon0: -3,
  dlat: 1,
  dlon: 1,
  nlat: 2,
  nlon: 2,
  levels: "850",
};

function meta(validTimeMs: number): WeatherSnapshotMeta {
  return { ...columns, valid_time_ms: validTimeMs, payload_bytes: 16_011 };
}

function record(validTimeMs: number, dir = 270): WeatherSnapshotRecord {
  return {
    ...columns,
    valid_time_ms: validTimeMs,
    payload: JSON.stringify(snapshot(validTimeMs, dir)),
  };
}

/** A promise this test resolves by hand, to force an out-of-order answer. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function keyOf(args: unknown): number {
  return (args as { key: { valid_time_ms: number } }).key.valid_time_ms;
}

describe("useHistoricalWeather", () => {
  beforeEach(() => {
    clearMockResponses();
  });

  it("is idle when there is no time to look up", () => {
    // An empty analysis set has no span. Nothing is fetched, and the caller
    // renders an explanation rather than falling back to the live snapshot.
    const { result } = renderHook(() => useHistoricalWeather(null, null));
    expect(result.current.map.status).toBe("idle");
    expect(result.current.map.entry).toBeNull();
  });

  it("fetches the snapshot nearest the map time", async () => {
    mockInvokeResponse("get_weather_history", [meta(BASE), meta(BASE + HOUR)]);
    mockInvokeResponse("get_weather_at", (args: unknown) => record(keyOf(args)));

    const { result } = renderHook(() => useHistoricalWeather(BASE + HOUR + 60_000, null));

    await waitFor(() => expect(result.current.map.status).toBe("found"));
    expect(result.current.map.entry?.validTimeMs).toBe(BASE + HOUR);
    expect(result.current.map.entry?.offsetMs).toBe(60_000);
    expect(result.current.map.entry?.snapshot.valid_time_ms).toBe(BASE + HOUR);
  });

  it("reports none when no hour was recorded near that time", async () => {
    mockInvokeResponse("get_weather_history", []);
    mockInvokeResponse("get_weather_at", null);

    const { result } = renderHook(() => useHistoricalWeather(BASE, null));

    await waitFor(() => expect(result.current.map.status).toBe("none"));
    expect(result.current.map.entry).toBeNull();
  });

  it("reports a malformed payload as none, not as a crash", async () => {
    mockInvokeResponse("get_weather_history", [meta(BASE)]);
    mockInvokeResponse("get_weather_at", { ...record(BASE), payload: "{oops" });

    const { result } = renderHook(() => useHistoricalWeather(BASE, null));

    await waitFor(() => expect(result.current.map.status).toBe("none"));
  });

  it("does not refetch a payload it already holds", async () => {
    let payloadFetches = 0;
    mockInvokeResponse("get_weather_history", [meta(BASE)]);
    mockInvokeResponse("get_weather_at", (args: unknown) => {
      payloadFetches += 1;
      return record(keyOf(args));
    });

    // Two different requested times that resolve onto the SAME model hour --
    // which is the ordinary case when dragging a browse window.
    const { result, rerender } = renderHook(
      ({ t }: { t: number }) => useHistoricalWeather(t, null),
      { initialProps: { t: BASE + 60_000 } },
    );
    await waitFor(() => expect(result.current.map.status).toBe("found"));

    rerender({ t: BASE + 120_000 });
    await waitFor(() => expect(result.current.map.entry?.requestedMs).toBe(BASE + 120_000));

    expect(payloadFetches).toBe(1);
  });

  it("discards a fetch superseded by a newer time", async () => {
    // `invoke` is not abortable, so a slow answer for an abandoned time must be
    // dropped on arrival rather than overwriting the newer one.
    const slow = deferred<WeatherSnapshotRecord>();
    mockInvokeResponse("get_weather_history", [meta(BASE), meta(BASE + 24 * HOUR)]);
    mockInvokeResponse("get_weather_at", (args: unknown) =>
      keyOf(args) === BASE ? slow.promise : record(keyOf(args)),
    );

    const { result, rerender } = renderHook(
      ({ t }: { t: number }) => useHistoricalWeather(t, null),
      { initialProps: { t: BASE } },
    );
    rerender({ t: BASE + 24 * HOUR });
    await waitFor(() => expect(result.current.map.entry?.validTimeMs).toBe(BASE + 24 * HOUR));

    // The abandoned fetch lands late; it must not win.
    slow.resolve(record(BASE));
    await Promise.resolve();
    expect(result.current.map.entry?.validTimeMs).toBe(BASE + 24 * HOUR);
  });

  it("resolves the map and aircraft slots independently", async () => {
    // The map follows the browsed window's end; an aircraft follows its own
    // last_seen. They are different instants by design.
    mockInvokeResponse("get_weather_history", [meta(BASE), meta(BASE + 24 * HOUR)]);
    mockInvokeResponse("get_weather_at", (args: unknown) => record(keyOf(args)));

    const { result } = renderHook(() => useHistoricalWeather(BASE + 24 * HOUR, BASE));

    await waitFor(() => expect(result.current.map.status).toBe("found"));
    await waitFor(() => expect(result.current.aircraft.status).toBe("found"));
    expect(result.current.map.entry?.validTimeMs).toBe(BASE + 24 * HOUR);
    expect(result.current.aircraft.entry?.validTimeMs).toBe(BASE);
  });

  it("reports storage being unavailable", async () => {
    // Distinct from "nothing recorded": the caller says so rather than
    // implying the weather simply was not captured.
    mockInvokeResponse("get_weather_history", () => {
      throw "Storage not available";
    });

    const { result } = renderHook(() => useHistoricalWeather(BASE, null));

    await waitFor(() => expect(result.current.map.status).toBe("unavailable"));
    expect(result.current.map.error).toContain("Storage not available");
  });

  it("settles once under StrictMode", async () => {
    // StrictMode double-invokes effects. The request id is bumped in the effect
    // BODY, never inside a setState updater -- the rule CLAUDE.md records from
    // useTrajectoryPlayback's requestAutoStart, where the second pass consumed
    // an already-emptied ref and the feature silently died in the real app.
    let payloadFetches = 0;
    mockInvokeResponse("get_weather_history", [meta(BASE)]);
    mockInvokeResponse("get_weather_at", (args: unknown) => {
      payloadFetches += 1;
      return record(keyOf(args));
    });

    const { result } = renderHook(() => useHistoricalWeather(BASE, null), {
      wrapper: StrictMode,
    });

    await waitFor(() => expect(result.current.map.status).toBe("found"));
    expect(result.current.map.entry?.validTimeMs).toBe(BASE);
    // Cached by model hour, so the doubled effect costs at most one payload.
    expect(payloadFetches).toBeLessThanOrEqual(1);
  });
});

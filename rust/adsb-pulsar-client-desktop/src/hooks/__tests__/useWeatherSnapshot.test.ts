import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { clearMockResponses, emitMockEvent, mockInvokeResponse } from "@/test/mocks/tauri";
import { useWeatherSnapshot } from "../useWeatherSnapshot";
import type { WeatherSnapshot } from "@/lib/weather";

function snapshot(validTimeMs: number): WeatherSnapshot {
  return {
    version: 1,
    source: "open-meteo",
    attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
    model: "best_match",
    fetched_at_ms: validTimeMs,
    valid_time_ms: validTimeMs,
    grid: { lat0: 47, lon0: -2, dlat: 1, dlon: 1, nlat: 1, nlon: 1 },
    surface: { mslp_hpa: [1013], wind_speed_kt: [10], wind_dir_deg: [270] },
    levels: { "250": { wind_speed_kt: [100], wind_dir_deg: [250] } },
  };
}

describe("useWeatherSnapshot", () => {
  beforeEach(() => {
    clearMockResponses();
  });

  it("starts with no snapshot, waiting", () => {
    mockInvokeResponse("get_weather_snapshot", null);
    mockInvokeResponse("get_weather_availability", "waiting");

    const { result } = renderHook(() => useWeatherSnapshot());

    expect(result.current.snapshot).toBeNull();
    expect(result.current.availability).toBe("waiting");
  });

  it("hydrates a snapshot the backend already holds", async () => {
    const snap = snapshot(1_000);
    mockInvokeResponse("get_weather_snapshot", snap);
    mockInvokeResponse("get_weather_availability", "available");

    const { result } = renderHook(() => useWeatherSnapshot());

    await waitFor(() => {
      expect(result.current.snapshot).toEqual(snap);
    });
    expect(result.current.availability).toBe("available");
  });

  it("takes each adsb:weather event as the new snapshot", async () => {
    mockInvokeResponse("get_weather_snapshot", null);
    mockInvokeResponse("get_weather_availability", "waiting");

    const { result } = renderHook(() => useWeatherSnapshot());
    await waitFor(() => {
      expect(result.current.availability).toBe("waiting");
    });

    const snap = snapshot(2_000);
    act(() => {
      emitMockEvent("adsb:weather", snap);
    });

    expect(result.current.snapshot).toEqual(snap);
    expect(result.current.availability).toBe("available");
  });

  it("reports an unsupported source", async () => {
    mockInvokeResponse("get_weather_snapshot", null);
    mockInvokeResponse("get_weather_availability", "unsupported_source");

    const { result } = renderHook(() => useWeatherSnapshot());

    await waitFor(() => {
      expect(result.current.availability).toBe("unsupported_source");
    });
  });

  it("keeps its defaults when the backend cannot be reached", async () => {
    // No mock responses: every invoke rejects, as outside Tauri.
    const { result } = renderHook(() => useWeatherSnapshot());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.snapshot).toBeNull();
    expect(result.current.availability).toBe("waiting");
  });

  it("re-checks availability when the feed status changes", async () => {
    mockInvokeResponse("get_weather_snapshot", null);
    mockInvokeResponse("get_weather_availability", "waiting");

    const { result } = renderHook(() => useWeatherSnapshot());
    await waitFor(() => {
      expect(result.current.availability).toBe("waiting");
    });

    // The feed was restarted on the socket source.
    mockInvokeResponse("get_weather_availability", "unsupported_source");
    act(() => {
      emitMockEvent("adsb:status", { is_running: true });
    });

    await waitFor(() => {
      expect(result.current.availability).toBe("unsupported_source");
    });
  });

  it("reports available once a snapshot is held, even if availability answered late", async () => {
    // The two mount-time requests race; a stale "waiting" must not hide a
    // snapshot that is already drawn.
    mockInvokeResponse("get_weather_snapshot", snapshot(1_000));
    mockInvokeResponse("get_weather_availability", "waiting");

    const { result } = renderHook(() => useWeatherSnapshot());

    await waitFor(() => {
      expect(result.current.snapshot).not.toBeNull();
    });
    expect(result.current.availability).toBe("available");
  });

  it("does not upgrade an unsupported source because an old snapshot is held", async () => {
    mockInvokeResponse("get_weather_snapshot", snapshot(1_000));
    mockInvokeResponse("get_weather_availability", "unsupported_source");

    const { result } = renderHook(() => useWeatherSnapshot());

    await waitFor(() => {
      expect(result.current.snapshot).not.toBeNull();
    });
    await waitFor(() => {
      expect(result.current.availability).toBe("unsupported_source");
    });
  });
});

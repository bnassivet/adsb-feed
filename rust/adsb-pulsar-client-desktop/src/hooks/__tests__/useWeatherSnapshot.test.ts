import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { clearMockResponses, emitMockEvent, mockInvokeResponse } from "@/test/mocks/tauri";
import { CONFIRM_TIMEOUT_MS, useWeatherSnapshot } from "../useWeatherSnapshot";
import type { WeatherServiceStatus, WeatherServiceView, WeatherSnapshot } from "@/lib/weather";

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

function serviceView(enabled: boolean): WeatherServiceView {
  const status: WeatherServiceStatus = {
    version: 1,
    enabled,
    state: enabled ? "idle" : "disabled",
    consecutive_failures: 0,
    rate_limit: null,
    last_success_ms: null,
    last_error: null,
    next_fetch_ms: null,
    snapshot_valid_time_ms: null,
    updated_at_ms: 1,
  };
  return { status, availability: "online" };
}

describe("useWeatherSnapshot: the weather service", () => {
  let sent: unknown[];

  beforeEach(() => {
    clearMockResponses();
    sent = [];
    mockInvokeResponse("get_weather_snapshot", null);
    mockInvokeResponse("get_weather_availability", "available");
    mockInvokeResponse("get_weather_service", serviceView(true));
    mockInvokeResponse("set_weather_service_enabled", (args: unknown) => {
      sent.push(args);
      return null;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates what the service last reported", async () => {
    const { result } = renderHook(() => useWeatherSnapshot());
    await waitFor(() => {
      expect(result.current.service).toEqual(serviceView(true));
    });
    expect(result.current.pendingEnabled).toBeNull();
  });

  it("takes each adsb:weather-service event as the service's state", async () => {
    const { result } = renderHook(() => useWeatherSnapshot());
    await waitFor(() => expect(result.current.service.status).not.toBeNull());

    act(() => {
      emitMockEvent("adsb:weather-service", serviceView(false));
    });
    expect(result.current.service).toEqual(serviceView(false));
  });

  it("sends the desired setting as a command", async () => {
    const { result } = renderHook(() => useWeatherSnapshot());
    await waitFor(() => expect(result.current.service.status).not.toBeNull());

    await act(async () => {
      result.current.setServiceEnabled(false);
    });
    expect(sent).toEqual([{ enabled: false }]);
  });

  it("stays pending after the command succeeds, until the service reports it", async () => {
    const { result } = renderHook(() => useWeatherSnapshot());
    await waitFor(() => expect(result.current.service.status).not.toBeNull());

    await act(async () => {
      result.current.setServiceEnabled(false);
    });
    // Accepted is not done: the status still says enabled.
    expect(result.current.pendingEnabled).toBe(false);
    expect(result.current.service.status?.enabled).toBe(true);

    act(() => {
      emitMockEvent("adsb:weather-service", serviceView(false));
    });
    expect(result.current.pendingEnabled).toBeNull();
  });

  it("does not treat a change made elsewhere as pending", async () => {
    const { result } = renderHook(() => useWeatherSnapshot());
    await waitFor(() => expect(result.current.service.status).not.toBeNull());
    await act(async () => {
      result.current.setServiceEnabled(false);
    });
    act(() => {
      emitMockEvent("adsb:weather-service", serviceView(false));
    });

    // Someone runs `make weather-enable`.
    act(() => {
      emitMockEvent("adsb:weather-service", serviceView(true));
    });
    expect(result.current.pendingEnabled).toBeNull();
    expect(result.current.service.status?.enabled).toBe(true);
  });

  it("clears pending and reports the reason when the command fails", async () => {
    mockInvokeResponse("set_weather_service_enabled", () => {
      throw "weather service at http://pi-roof:8789/v1/enabled is unreachable";
    });
    const { result } = renderHook(() => useWeatherSnapshot());
    await waitFor(() => expect(result.current.service.status).not.toBeNull());

    await act(async () => {
      result.current.setServiceEnabled(false);
    });

    await waitFor(() => expect(result.current.pendingEnabled).toBeNull());
    expect(result.current.serviceError).toMatch(/unreachable/);
  });

  it("gives up waiting for confirmation after a timeout", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWeatherSnapshot());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      result.current.setServiceEnabled(false);
    });
    expect(result.current.pendingEnabled).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
    });
    expect(result.current.pendingEnabled).toBeNull();
    expect(result.current.serviceError).toMatch(/no confirmation/i);
  });

  it("clears a previous error when a new command is sent", async () => {
    mockInvokeResponse("set_weather_service_enabled", () => {
      throw "HTTP 500";
    });
    const { result } = renderHook(() => useWeatherSnapshot());
    await waitFor(() => expect(result.current.service.status).not.toBeNull());
    await act(async () => {
      result.current.setServiceEnabled(false);
    });
    await waitFor(() => expect(result.current.serviceError).not.toBeNull());

    mockInvokeResponse("set_weather_service_enabled", () => null);
    await act(async () => {
      result.current.setServiceEnabled(false);
    });
    expect(result.current.serviceError).toBeNull();
  });
});

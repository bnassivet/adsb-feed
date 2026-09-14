import { beforeEach, describe, expect, it } from "vitest";
import { clearMockResponses, mockInvokeResponse } from "@/test/mocks/tauri";
import { getWeatherAvailability, getWeatherSnapshot } from "../commands";
import type { WeatherSnapshot } from "../weather";

const snapshot: WeatherSnapshot = {
  version: 1,
  source: "open-meteo",
  attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
  model: "best_match",
  fetched_at_ms: 1_789_413_000_000,
  valid_time_ms: 1_789_412_400_000,
  grid: { lat0: 47, lon0: -2, dlat: 1, dlon: 1, nlat: 1, nlon: 1 },
  surface: { mslp_hpa: [1021.8], wind_speed_kt: [3.5], wind_dir_deg: [304] },
  levels: { "250": { wind_speed_kt: [36.5], wind_dir_deg: [250] } },
};

describe("weather commands", () => {
  beforeEach(() => {
    clearMockResponses();
  });

  it("getWeatherSnapshot returns the snapshot the backend holds", async () => {
    mockInvokeResponse("get_weather_snapshot", snapshot);
    await expect(getWeatherSnapshot()).resolves.toEqual(snapshot);
  });

  it("getWeatherSnapshot returns null before any snapshot has arrived", async () => {
    mockInvokeResponse("get_weather_snapshot", null);
    await expect(getWeatherSnapshot()).resolves.toBeNull();
  });

  it("getWeatherAvailability passes the backend's reason through", async () => {
    mockInvokeResponse("get_weather_availability", "unsupported_source");
    await expect(getWeatherAvailability()).resolves.toBe("unsupported_source");
  });
});

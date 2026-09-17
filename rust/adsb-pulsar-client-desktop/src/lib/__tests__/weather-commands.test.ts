import { beforeEach, describe, expect, it } from "vitest";
import { clearMockResponses, mockInvokeResponse } from "@/test/mocks/tauri";
import {
  getWeatherAt,
  getWeatherAvailability,
  getWeatherHistory,
  getWeatherSnapshot,
} from "../commands";
import type { WeatherSnapshot } from "../weather";
import type { WeatherSnapshotMeta, WeatherSnapshotRecord } from "../types";

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

/** The columns a listing and a full row share. */
const recorded = {
  source_id: "desktop",
  valid_time_ms: 1_789_412_400_000,
  fetched_at_ms: 1_789_413_000_000,
  received_at_ms: 1_789_413_060_000,
  source: "open-meteo",
  model: "best_match",
  version: 1,
  lat0: 42,
  lon0: -10,
  dlat: 1,
  dlon: 1,
  nlat: 11,
  nlon: 17,
  levels: "200,250,300,500,700,850",
};

/** A recorded row's metadata, as the listing returns it: size, not content. */
const meta: WeatherSnapshotMeta = { ...recorded, payload_bytes: 16_011 };

/** The same row with its payload — the verbatim published JSON. */
const record: WeatherSnapshotRecord = {
  ...recorded,
  payload: JSON.stringify(snapshot),
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

  it("getWeatherHistory lists recorded model hours without payloads", async () => {
    // The listing is metadata only: a snapshot is ~16 KB, so a page of them
    // whole would be several hundred KB a caller almost never wants.
    mockInvokeResponse("get_weather_history", [meta]);
    const rows = await getWeatherHistory({ start_ms: 1, end_ms: 2, limit: 24 });
    expect(rows).toEqual([meta]);
    expect(rows[0]).not.toHaveProperty("payload");
    expect(rows[0].payload_bytes).toBe(16_011);
  });

  it("getWeatherHistory sends its arguments under `query`", async () => {
    // Struct args go under a named key; only scalars are passed bare.
    let received: unknown;
    mockInvokeResponse("get_weather_history", (args: unknown) => {
      received = args;
      return [];
    });
    await getWeatherHistory({ start_ms: 10, end_ms: 20 });
    expect(received).toEqual({ query: { start_ms: 10, end_ms: 20 } });
  });

  it("getWeatherAt returns one recorded snapshot with its payload", async () => {
    mockInvokeResponse("get_weather_at", record);
    const got = await getWeatherAt({ valid_time_ms: 1_789_412_400_000 });
    expect(got?.payload).toBe(record.payload);
  });

  it("getWeatherAt returns null for a model hour that was never recorded", async () => {
    // Absent is not an error: the caller must be able to tell it apart from
    // storage being unavailable.
    mockInvokeResponse("get_weather_at", null);
    await expect(getWeatherAt({ valid_time_ms: 1 })).resolves.toBeNull();
  });

  it("getWeatherAt sends its arguments under `key`", async () => {
    let received: unknown;
    mockInvokeResponse("get_weather_at", (args: unknown) => {
      received = args;
      return null;
    });
    await getWeatherAt({ valid_time_ms: 7, source_id: "desktop" });
    expect(received).toEqual({ key: { valid_time_ms: 7, source_id: "desktop" } });
  });
});

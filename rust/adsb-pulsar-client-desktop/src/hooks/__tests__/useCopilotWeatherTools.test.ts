import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useCopilotTools,
  type DisplayToolsConfig,
  type WeatherToolsConfig,
} from "../useCopilotTools";
import type { WeatherSnapshot, WindFields } from "@/lib/weather";

const registeredTools = new Map<
  string,
  { handler: (...args: unknown[]) => unknown; description?: string }
>();

vi.mock("@copilotkit/react-core/v2", () => ({
  useFrontendTool: (opts: {
    name: string;
    handler: (...args: unknown[]) => unknown;
    description?: string;
  }) => {
    if (registeredTools.has(opts.name)) return;
    registeredTools.set(opts.name, { handler: opts.handler, description: opts.description });
  },
}));

vi.mock("@/lib/commands", () => ({
  getStorageStats: vi.fn(),
  getAircraftSummary: vi.fn(),
  getFlightSummary: vi.fn(),
  getStatus: vi.fn(),
  getMetrics: vi.fn(),
  getTrajectory: vi.fn(),
  startFeed: vi.fn(),
  stopFeed: vi.fn(),
  getEventsOfInterest: vi.fn().mockResolvedValue([]),
  createEventOfInterest: vi.fn().mockResolvedValue({}),
  getScenario: vi.fn(),
}));

function uniform(dir: number, speed: number): WindFields {
  return { wind_dir_deg: [dir, dir, dir, dir], wind_speed_kt: [speed, speed, speed, speed] };
}

/** 2 x 2 grid over (46..47, -3..-2), valid "now" in these tests. */
function snapshot(): WeatherSnapshot {
  return {
    version: 1,
    source: "open-meteo",
    attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
    model: "best_match",
    fetched_at_ms: Date.now(),
    valid_time_ms: Date.now(),
    grid: { lat0: 46, lon0: -3, dlat: 1, dlon: 1, nlat: 2, nlon: 2 },
    surface: { ...uniform(270, 10), mslp_hpa: [1013, 1013, 1013, 1013] },
    levels: { "850": uniform(270, 20), "250": uniform(250, 100) },
  };
}

function makeWeather(overrides: Partial<WeatherToolsConfig> = {}): WeatherToolsConfig {
  return {
    snapshot: snapshot(),
    availability: "available",
    show: false,
    level: "surface",
    showBarbs: true,
    showParticles: false,
    setShowWeather: vi.fn(),
    setWeatherLevel: vi.fn(),
    setShowWeatherBarbs: vi.fn(),
    setShowWeatherParticles: vi.fn(),
    ...overrides,
  };
}

/** Only the fields the weather tools read; the rest of the page is irrelevant here. */
function makeConfig(weather: WeatherToolsConfig | undefined): DisplayToolsConfig {
  return {
    tracks: [],
    receiverLocation: { lat: 46.5, lng: -2.5 },
    weather,
  } as unknown as DisplayToolsConfig;
}

async function call(name: string, args: Record<string, unknown>) {
  const tool = registeredTools.get(name);
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return JSON.parse((await tool.handler(args)) as string);
}

function render(weather: WeatherToolsConfig | undefined) {
  registeredTools.clear();
  renderHook(() => useCopilotTools(makeConfig(weather)));
}

describe("setWeatherLayer", () => {
  let weather: WeatherToolsConfig;

  beforeEach(() => {
    weather = makeWeather();
    render(weather);
  });

  it("changes only the fields it is given", async () => {
    const result = await call("setWeatherLayer", { enabled: true });

    expect(weather.setShowWeather).toHaveBeenCalledWith(true);
    expect(weather.setWeatherLevel).not.toHaveBeenCalled();
    expect(weather.setShowWeatherBarbs).not.toHaveBeenCalled();
    expect(weather.setShowWeatherParticles).not.toHaveBeenCalled();
    expect(result).toMatchObject({ shown: true, level: "SFC", barbs: true, particles: false });
  });

  it("resolves a flight level to a carried pressure level", async () => {
    const result = await call("setWeatherLayer", { level: "FL340" });

    expect(weather.setWeatherLevel).toHaveBeenCalledWith(250);
    expect(result.level).toBe("FL340 · 250 hPa");
  });

  it("turns the layer on when asked for barbs or particles, or nothing would show", async () => {
    const result = await call("setWeatherLayer", { particles: true });

    expect(weather.setShowWeatherParticles).toHaveBeenCalledWith(true);
    expect(weather.setShowWeather).toHaveBeenCalledWith(true);
    expect(result).toMatchObject({ shown: true, particles: true });
  });

  it("rejects an unknown level without changing anything", async () => {
    const result = await call("setWeatherLayer", { enabled: true, level: "500" });

    expect(result.error).toMatch(/FL340 · 250 hPa/);
    expect(weather.setShowWeather).not.toHaveBeenCalled();
    expect(weather.setWeatherLevel).not.toHaveBeenCalled();
  });

  it("refuses when the live source cannot carry weather", async () => {
    weather = makeWeather({ availability: "unsupported_source", snapshot: null });
    render(weather);

    const result = await call("setWeatherLayer", { enabled: true });

    expect(result.error).toMatch(/MQTT/);
    expect(weather.setShowWeather).not.toHaveBeenCalled();
  });

  it("enables the layer before the first snapshot has arrived", async () => {
    weather = makeWeather({ availability: "waiting", snapshot: null });
    render(weather);

    const result = await call("setWeatherLayer", { enabled: true });

    expect(weather.setShowWeather).toHaveBeenCalledWith(true);
    expect(result.validity).toMatch(/waiting/i);
  });

  it("reports weather as unavailable when the page provides none", async () => {
    render(undefined);

    expect(await call("setWeatherLayer", { enabled: true })).toHaveProperty("error");
  });
});

import { StrictMode } from "react";
import { useCallback, useMemo, useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { clearMockResponses, mockInvokeResponse } from "@/test/mocks/tauri";
import { useHistoricalWeather } from "../useHistoricalWeather";
import {
  selectAircraftWind,
  selectMapWeather,
  tracksTimeSpan,
  weatherTimesFor,
} from "@/lib/weather-history";
import type { WeatherSnapshot, WindFields } from "@/lib/weather";
import type { AircraftTrack, WeatherSnapshotMeta, WeatherSnapshotRecord } from "@/lib/types";

/**
 * The browse-to-weather path, wired exactly as `page.tsx` wires it.
 *
 * `page.tsx` has no tests of its own, and CLAUDE.md records that
 * `chatTrajectoryFlow.test.ts` caught what the hook-only StrictMode test
 * missed -- the composition is where these bugs live, not the pieces.
 *
 * The bug being pinned: the map used to draw whatever `adsb:weather` last
 * pushed, with no reference to what was on screen. Browsing a week-old track
 * showed today's winds over it, silently.
 */

const HOUR = 3_600_000;
const NOW = 1_789_412_400_000;
/** Two days back, and four hours before that: distinct, far-apart hours. */
const MAP_HOUR = NOW - 48 * HOUR;
const PLANE_HOUR = NOW - 52 * HOUR;

function uniform(dir: number, speed: number, n = 4): WindFields {
  return { wind_dir_deg: Array(n).fill(dir), wind_speed_kt: Array(n).fill(speed) };
}

/**
 * Uniform through the whole column, so an assertion about wind direction
 * reports which snapshot was chosen rather than the interpolation's
 * arithmetic between disagreeing layers.
 */
function column(validTimeMs: number, dir: number): WeatherSnapshot {
  return {
    version: 1,
    source: "open-meteo",
    attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
    model: "best_match",
    fetched_at_ms: validTimeMs,
    valid_time_ms: validTimeMs,
    grid: { lat0: 46, lon0: -3, dlat: 1, dlon: 1, nlat: 2, nlon: 2 },
    surface: { ...uniform(dir, 40), mslp_hpa: [1013, 1013, 1013, 1013] },
    levels: { "850": uniform(dir, 40), "250": uniform(dir, 40) },
  };
}

const columns = {
  source_id: "desktop",
  fetched_at_ms: NOW,
  received_at_ms: NOW,
  source: "open-meteo",
  model: "best_match",
  version: 1,
  lat0: 46,
  lon0: -3,
  dlat: 1,
  dlon: 1,
  nlat: 2,
  nlon: 2,
  levels: "250,850",
};

function meta(validTimeMs: number): WeatherSnapshotMeta {
  return { ...columns, valid_time_ms: validTimeMs, payload_bytes: 16_011 };
}

/** Each recorded hour carries a different wind, so routing is visible. */
const DIR_BY_HOUR: Record<number, number> = { [MAP_HOUR]: 90, [PLANE_HOUR]: 180 };

function record(validTimeMs: number): WeatherSnapshotRecord {
  return {
    ...columns,
    valid_time_ms: validTimeMs,
    payload: JSON.stringify(column(validTimeMs, DIR_BY_HOUR[validTimeMs] ?? 270)),
  };
}

function track(firstSeen: number, lastSeen: number): AircraftTrack {
  return {
    hex_ident: "A1B2C3",
    callsign: "AFR123",
    altitude: 34_000,
    ground_speed: 451,
    track: 263,
    latitude: 46.5,
    longitude: -2.5,
    vertical_rate: 0,
    squawk: "1000",
    is_on_ground: false,
    timestamp: "2026/09/17 10:30:00.000",
    positions: [],
    first_seen: firstSeen,
    last_seen: lastSeen,
    message_count: 12,
  };
}

/** The live hour, which must never reach the map while browsing. */
const LIVE = column(NOW, 250);

/** Mirrors page.tsx: mode, the browse seam, the analysis set and both selectors. */
function usePageWiring() {
  const [isLive, setIsLive] = useState(true);
  const [browseEndMs, setBrowseEndMs] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<AircraftTrack[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<AircraftTrack | null>(null);
  const [live, setLive] = useState<WeatherSnapshot | null>(LIVE);

  // useCallback because DBHistoryContent's doBrowse lists onBrowse in its
  // dependency array and is captured by six handlers.
  const handleBrowse = useCallback((_startMs: number, endMs: number) => {
    setBrowseEndMs(endMs);
  }, []);

  // O(n) over thousands of tracks, so never in a bare render.
  const analysisSpan = useMemo(() => tracksTimeSpan(analysis), [analysis]);

  const times = weatherTimesFor({
    isLive,
    analysisSpan,
    browseEndMs,
    selectedTrack,
    isDbHistorySelection: !isLive,
    isImportedSelection: false,
  });

  const recorded = useHistoricalWeather(times.mapTimeMs, times.aircraftTimeMs);

  const mapWeather = selectMapWeather({
    isLive,
    show: true,
    availability: "available",
    live,
    liveNowMs: NOW,
    recorded: recorded.map.entry,
    viewTimeMs: times.mapTimeMs,
  });

  const wind = selectedTrack
    ? selectAircraftWind({
        track: selectedTrack,
        isHistoricalSelection: !isLive,
        live,
        liveNowMs: NOW,
        recorded: recorded.aircraft.entry,
      })
    : null;

  return {
    mapWeather,
    wind,
    recorded,
    times,
    browse: handleBrowse,
    setIsLive,
    setAnalysis,
    setSelectedTrack,
    setLive,
  };
}

describe("browsing history and the weather it shows", () => {
  beforeEach(() => {
    clearMockResponses();
    mockInvokeResponse("get_weather_history", [meta(MAP_HOUR), meta(PLANE_HOUR), meta(NOW)]);
    mockInvokeResponse("get_weather_at", (args: unknown) =>
      record((args as { key: { valid_time_ms: number } }).key.valid_time_ms),
    );
  });

  it("draws the live snapshot before anything is browsed", () => {
    const { result } = renderHook(() => usePageWiring());
    expect(result.current.mapWeather.source).toBe("live");
    expect(result.current.mapWeather.snapshot).toBe(LIVE);
  });

  it("draws the recorded hour of the window being browsed", async () => {
    const { result } = renderHook(() => usePageWiring());

    act(() => {
      result.current.setIsLive(false);
      result.current.browse(MAP_HOUR - HOUR, MAP_HOUR);
    });

    await waitFor(() => expect(result.current.mapWeather.source).toBe("recorded"));
    expect(result.current.mapWeather.snapshot?.valid_time_ms).toBe(MAP_HOUR);
  });

  it("a live snapshot arriving while browsing does not change the map", async () => {
    // The MQTT subscription keeps running while history is on screen. The
    // choice is made on MODE, never on "whichever value happens to be
    // non-null" -- otherwise a retained republish would silently repaint
    // two-day-old tracks with the current hour's winds.
    const { result } = renderHook(() => usePageWiring());

    act(() => {
      result.current.setIsLive(false);
      result.current.browse(MAP_HOUR - HOUR, MAP_HOUR);
    });
    await waitFor(() => expect(result.current.mapWeather.source).toBe("recorded"));

    act(() => result.current.setLive(column(NOW, 310)));

    expect(result.current.mapWeather.source).toBe("recorded");
    expect(result.current.mapWeather.snapshot?.valid_time_ms).toBe(MAP_HOUR);
  });

  it("follows the tracks on screen once they are added", async () => {
    // Analysis accumulates across browses, so the set outranks the last window.
    const { result } = renderHook(() => usePageWiring());

    act(() => {
      result.current.setIsLive(false);
      result.current.browse(PLANE_HOUR - HOUR, PLANE_HOUR);
    });
    await waitFor(() => expect(result.current.mapWeather.source).toBe("recorded"));

    act(() => result.current.setAnalysis([track(MAP_HOUR - HOUR, MAP_HOUR)]));

    await waitFor(() =>
      expect(result.current.mapWeather.snapshot?.valid_time_ms).toBe(MAP_HOUR),
    );
  });

  it("gives a selected aircraft the wind of its own hour, not the map's", async () => {
    // The map follows the window's end; each aircraft follows its own
    // last_seen. They are different instants by design.
    const { result } = renderHook(() => usePageWiring());

    act(() => {
      result.current.setIsLive(false);
      result.current.setAnalysis([track(MAP_HOUR - HOUR, MAP_HOUR)]);
      result.current.setSelectedTrack(track(PLANE_HOUR - HOUR, PLANE_HOUR));
    });

    await waitFor(() => expect(result.current.wind).not.toBeNull());
    expect(result.current.mapWeather.snapshot?.valid_time_ms).toBe(MAP_HOUR);
    expect(result.current.wind?.dirDeg).toBe(180); // PLANE_HOUR's wind, not MAP_HOUR's
  });

  it("returns to the live snapshot on going back to live", async () => {
    const { result } = renderHook(() => usePageWiring());

    act(() => {
      result.current.setIsLive(false);
      result.current.browse(MAP_HOUR - HOUR, MAP_HOUR);
    });
    await waitFor(() => expect(result.current.mapWeather.source).toBe("recorded"));

    act(() => result.current.setIsLive(true));

    expect(result.current.mapWeather.source).toBe("live");
    expect(result.current.mapWeather.snapshot).toBe(LIVE);
  });

  it("says nothing was recorded rather than falling back to live", async () => {
    // The regression check, and the mirror image of the bug: a window with no
    // recorded hour must go empty. Today it would show the current winds.
    clearMockResponses();
    mockInvokeResponse("get_weather_history", []);
    mockInvokeResponse("get_weather_at", null);

    const { result } = renderHook(() => usePageWiring());

    act(() => {
      result.current.setIsLive(false);
      result.current.browse(MAP_HOUR - HOUR, MAP_HOUR);
    });

    await waitFor(() => expect(result.current.recorded.map.status).toBe("none"));
    expect(result.current.mapWeather.snapshot).toBeNull();
    expect(result.current.mapWeather.source).toBe("none");
  });

  it("works under StrictMode", async () => {
    // Next.js enables StrictMode by default. The request id is bumped in the
    // effect body, never inside a setState updater -- the rule CLAUDE.md
    // records from useTrajectoryPlayback's auto-start, which died in the real
    // app while every non-Strict test passed.
    const { result } = renderHook(() => usePageWiring(), { wrapper: StrictMode });

    act(() => {
      result.current.setIsLive(false);
      result.current.browse(MAP_HOUR - HOUR, MAP_HOUR);
    });

    await waitFor(() => expect(result.current.mapWeather.source).toBe("recorded"));
    expect(result.current.mapWeather.snapshot?.valid_time_ms).toBe(MAP_HOUR);
  });
});

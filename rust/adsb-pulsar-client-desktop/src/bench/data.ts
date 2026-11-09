/**
 * Seeded synthetic aircraft tracks for the map render benchmark.
 *
 * Deterministic so every variant (and every machine) renders exactly the same
 * points. Batch tracks use `ColumnarPositions` like DB history does; live tracks
 * use tuple arrays like the feed does.
 */
import { ColumnarPositions, isColumnar, type AircraftTrack } from "@/lib/types";

/** Around the app's DEFAULT_CENTER (45.5, -73.6). */
export const BENCH_BBOX = { south: 43.5, north: 47.5, west: -76.6, east: -70.6 } as const;
export const BENCH_CENTER: [number, number] = [45.5, -73.6];

const MIN_TRACK = 200;
const MAX_TRACK = 600;
const LIVE_CAP = 100;
const NULL_ALT_RATE = 0.01;
const BASE_EPOCH_MS = Date.UTC(2026, 10, 1, 12);

/** mulberry32 — tiny, fast, good enough for test data. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Walker { lat: number; lng: number; heading: number; speed: number; alt: number }

function step(w: Walker, rand: () => number): void {
  w.heading += (rand() - 0.5) * 0.2;
  let lat = w.lat + Math.cos(w.heading) * w.speed;
  let lng = w.lng + Math.sin(w.heading) * w.speed * 1.4;
  if (lat < BENCH_BBOX.south || lat > BENCH_BBOX.north) {
    w.heading = Math.PI - w.heading;
    lat = Math.min(BENCH_BBOX.north, Math.max(BENCH_BBOX.south, lat));
  }
  if (lng < BENCH_BBOX.west || lng > BENCH_BBOX.east) {
    w.heading = -w.heading;
    lng = Math.min(BENCH_BBOX.east, Math.max(BENCH_BBOX.west, lng));
  }
  w.lat = lat;
  w.lng = lng;
  w.alt = Math.min(45_000, Math.max(0, w.alt + (rand() - 0.5) * 400));
}

function newWalker(rand: () => number): Walker {
  const m = 0.1;
  return {
    lat: BENCH_BBOX.south + m + rand() * (BENCH_BBOX.north - BENCH_BBOX.south - 2 * m),
    lng: BENCH_BBOX.west + m + rand() * (BENCH_BBOX.east - BENCH_BBOX.west - 2 * m),
    heading: rand() * Math.PI * 2,
    speed: 0.002 + rand() * 0.004,
    alt: rand() * 40_000,
  };
}

function trackLengths(points: number, rand: () => number): number[] {
  if (points < 2) return [points];
  const lengths: number[] = [];
  let left = points;
  while (left > 0) {
    const want = MIN_TRACK + Math.floor(rand() * (MAX_TRACK - MIN_TRACK));
    const take = Math.min(want, left);
    lengths.push(take);
    left -= take;
  }
  // A remainder too short to be a track is folded into the previous one.
  if (lengths.length > 1 && lengths[lengths.length - 1] < 2) {
    lengths[lengths.length - 2] += lengths.pop()!;
  }
  return lengths;
}

function makeTrack(i: number, lat: number, lng: number, alt: number | null, heading: number): AircraftTrack {
  return {
    hex_ident: (0xa00000 + i).toString(16).toUpperCase(),
    callsign: `BNC${String(i).padStart(4, "0")}`,
    altitude: alt,
    ground_speed: 420,
    track: ((heading * 180) / Math.PI + 360) % 360,
    latitude: lat,
    longitude: lng,
    vertical_rate: 0,
    squawk: "1200",
    is_on_ground: false,
    timestamp: new Date(BASE_EPOCH_MS).toISOString(),
    positions: [],
    first_seen: BASE_EPOCH_MS - 600_000,
    last_seen: BASE_EPOCH_MS,
    message_count: 100,
    track_id: `bench-${i}`,
  };
}

export interface GenerateOptions {
  points: number;
  seed: number;
  /** Tuple-array live tracks (capped at 100 positions) instead of columnar batch tracks. */
  live?: boolean;
  /** Live mode only: number of aircraft. */
  aircraft?: number;
}

export function generateTracks({ points, seed, live = false, aircraft = 500 }: GenerateOptions): AircraftTrack[] {
  const rand = rng(seed);
  const lengths = live
    ? Array.from({ length: aircraft }, () => Math.max(2, Math.min(LIVE_CAP, Math.floor(points / aircraft))))
    : trackLengths(points, rand);

  return lengths.map((len, i) => {
    const w = newWalker(rand);
    const lat = new Float64Array(len);
    const lng = new Float64Array(len);
    const alt = new Float64Array(len);
    for (let k = 0; k < len; k++) {
      if (k > 0) step(w, rand);
      lat[k] = w.lat;
      lng[k] = w.lng;
      alt[k] = rand() < NULL_ALT_RATE ? NaN : Math.round(w.alt);
    }
    const lastAlt = Number.isNaN(alt[len - 1]) ? null : alt[len - 1];
    const t = makeTrack(i, w.lat, w.lng, lastAlt, w.heading);
    t.positions = live
      ? Array.from({ length: len }, (_, k) => [lat[k], lng[k], Number.isNaN(alt[k]) ? null : alt[k]])
      : new ColumnarPositions(lat, lng, alt);
    return t;
  });
}

/**
 * One live tick: every aircraft moves one step along its current heading.
 * Returns new track objects (as the tracking context does), so React and
 * identity-keyed layers see a change.
 */
export function liveStep(tracks: AircraftTrack[], seed: number): AircraftTrack[] {
  const rand = rng(seed);
  return tracks.map((t) => {
    if (isColumnar(t.positions)) throw new Error("liveStep expects live (tuple) tracks");
    const prev = t.positions;
    const [lat, lng, alt] = prev[prev.length - 1];
    const w: Walker = {
      lat, lng,
      heading: ((t.track ?? 0) * Math.PI) / 180,
      speed: 0.004,
      alt: alt ?? t.altitude ?? 10_000,
    };
    step(w, rand);
    const nextAlt = Math.round(w.alt);
    const positions: [number, number, number | null][] = [...prev, [w.lat, w.lng, nextAlt]];
    if (positions.length > LIVE_CAP) positions.shift();
    return {
      ...t,
      positions,
      latitude: w.lat,
      longitude: w.lng,
      altitude: nextAlt,
      track: ((w.heading * 180) / Math.PI + 360) % 360,
      last_seen: t.last_seen + 500,
    };
  });
}

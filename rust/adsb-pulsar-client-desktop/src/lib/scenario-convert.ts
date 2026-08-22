/**
 * Conversion between persisted scenario tracks and the in-memory
 * `AgentTrajectory` the map and playback stack already understand.
 *
 * Keeping this pure and separate from React means the storage shape can change
 * without touching a component, and every edge case below is directly testable.
 */
import type { AgentTrajectory, DynamicWaypoint } from "./simulation-data";
import type { CreateScenarioTrack, ScenarioTrack } from "./types";

/**
 * Parse a track's stored waypoints.
 *
 * A corrupt or hand-edited row must not take down the whole scenario, so a
 * failure yields an empty route: the track still lists, still has its identity,
 * and simply draws nothing. Throwing here would lose every other track too.
 */
function parseWaypoints(json: string): DynamicWaypoint[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as DynamicWaypoint[]) : [];
  } catch {
    return [];
  }
}

/**
 * Pull the route hint out of a track's stored `SimulateRequest`.
 *
 * Same tolerance as `parseWaypoints`: a corrupt or hand-edited request must not
 * cost the track its whole digest, so anything unusable reads as "no route" and
 * the digest falls back to describing the waypoints.
 */
function parseRouteHint(requestJson: string | null): string | null {
  if (!requestJson) return null;
  try {
    const parsed: unknown = JSON.parse(requestJson);
    const hint = (parsed as { routeHint?: unknown } | null)?.routeHint;
    if (typeof hint !== "string") return null;
    return hint.trim() === "" ? null : hint;
  } catch {
    return null;
  }
}

/** Rebuild the playable trajectory for one persisted scenario track. */
export function trackToTrajectory(track: ScenarioTrack): AgentTrajectory {
  return {
    hex_ident: track.hex_ident,
    callsign: track.callsign,
    category: track.category as AgentTrajectory["category"],
    waypoints: parseWaypoints(track.waypoints_json),
  };
}

/** Rebuild every track in a scenario, preserving order. */
export function scenarioTracksToTrajectories(tracks: ScenarioTrack[]): AgentTrajectory[] {
  return tracks.map(trackToTrajectory);
}

/**
 * Prepare a generated trajectory for persistence into a scenario.
 *
 * `request` is the `SimulateRequest` that produced it — stored so the track can
 * later be regenerated or inspected for provenance. `null` for a track with no
 * generating request.
 */
export function trajectoryToCreateTrack(
  trajectory: AgentTrajectory,
  scenarioId: string,
  startOffsetS: number,
  request: unknown | null,
): CreateScenarioTrack {
  return {
    scenario_id: scenarioId,
    hex_ident: trajectory.hex_ident,
    callsign: trajectory.callsign,
    category: trajectory.category,
    start_offset_s: startOffsetS,
    waypoints_json: JSON.stringify(trajectory.waypoints),
    request_json: request === null ? null : JSON.stringify(request),
  };
}

/**
 * Drop trajectories whose `hex_ident` has already been seen, keeping the first.
 *
 * `agentTrajectories` concatenates two independent feeds — the saved scenario
 * tracks and the staged (unsaved) ones — and nothing keeps a hex from appearing
 * in both. Two ways it happens:
 *
 * - committing a staged trajectory refetches the scenario *before* the staged
 *   set is filtered, so for one render the same aircraft is in both feeds;
 * - a fresh generation can return a hex the scenario already has saved.
 *
 * Either way React sees two children with the same key and warns, and the map
 * may drop or duplicate a marker. Deduping where the two feeds meet fixes both
 * without either side needing to know about the other. Scenario tracks are
 * listed first, so the *saved* aircraft is the one that survives.
 *
 * Returns the input untouched when there was nothing to remove.
 */
export function dedupeTrajectoriesByHex(trajectories: AgentTrajectory[]): AgentTrajectory[] {
  const seen = new Set<string>();
  const deduped: AgentTrajectory[] = [];

  for (const t of trajectories) {
    if (seen.has(t.hex_ident)) continue;
    seen.add(t.hex_ident);
    deduped.push(t);
  }

  return deduped.length === trajectories.length ? trajectories : deduped;
}

/**
 * Prepare freshly generated trajectories to sit alongside the saved ones.
 *
 * Any incoming hex that already belongs to a saved scenario track (or to an
 * earlier aircraft in the same batch) is reassigned. Without this,
 * `dedupeTrajectoriesByHex` would drop the newcomer as the duplicate and the
 * user would press Generate and see nothing appear — the aircraft would exist
 * but be invisible behind the saved one holding its key.
 *
 * Returns the input untouched when no hex had to change.
 */
export function stageTrajectories(
  incoming: AgentTrajectory[],
  existingHexes: string[],
): AgentTrajectory[] {
  const taken = [...existingHexes];
  let changed = false;

  const staged = incoming.map((t) => {
    const hex = uniqueHexIdent(taken, t.hex_ident);
    taken.push(hex);
    if (hex === t.hex_ident) return t;
    changed = true;
    return { ...t, hex_ident: hex };
  });

  return changed ? staged : incoming;
}

/**
 * A compact, LLM-facing summary of one persisted track.
 *
 * Deliberately not the waypoints: the raw arrays are large, mostly redundant,
 * and give the model nothing a description needs. Nulls mean "no route" — a
 * track whose waypoints failed to parse, or which has none yet.
 */
export interface TrackDigest {
  callsign: string;
  category: string;
  /** Seconds into the scenario before this aircraft appears. */
  start_offset_s: number;
  /**
   * The route hint this aircraft was generated from, when one is known.
   *
   * What the aircraft was *asked* to do beats anything derived from the
   * waypoints it ended up with, so the description generator uses this instead
   * of the kinematic fields below whenever it is present.
   */
  route: string | null;
  waypoint_count: number;
  /** Seconds from the track's own start to its last waypoint. */
  duration_s: number;
  /** Distinct phases in the order flown, repeats collapsed. */
  phases: string[];
  alt_ft_min: number | null;
  alt_ft_max: number | null;
  speed_kts_min: number | null;
  speed_kts_max: number | null;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
}

/**
 * Summarise one track for the description generator.
 *
 * Pure, and read-only over the track — `trackDigest` runs across the same rows
 * the map renders, so it must never reorder or renumber anything.
 */
export function trackDigest(track: ScenarioTrack): TrackDigest {
  const waypoints = parseWaypoints(track.waypoints_json);

  const base = {
    callsign: track.callsign,
    category: track.category,
    start_offset_s: track.start_offset_s,
    route: parseRouteHint(track.request_json),
    waypoint_count: waypoints.length,
  };

  if (waypoints.length === 0) {
    return {
      ...base,
      duration_s: 0,
      phases: [],
      alt_ft_min: null,
      alt_ft_max: null,
      speed_kts_min: null,
      speed_kts_max: null,
      start_lat: null,
      start_lng: null,
      end_lat: null,
      end_lng: null,
    };
  }

  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];

  // Collapse consecutive repeats rather than dedupe globally: a route that
  // climbs, cruises, descends and climbs again should read that way.
  const phases: string[] = [];
  for (const w of waypoints) {
    if (phases[phases.length - 1] !== w.phase) phases.push(w.phase);
  }

  const alts = waypoints.map((w) => w.alt_ft);
  const speeds = waypoints.map((w) => w.speed_kts);

  return {
    ...base,
    // The last waypoint's own offset — waypoints are unevenly spaced, so the
    // count says nothing about how long the track lasts.
    duration_s: last.t_offset_s,
    phases,
    alt_ft_min: Math.min(...alts),
    alt_ft_max: Math.max(...alts),
    speed_kts_min: Math.min(...speeds),
    speed_kts_max: Math.max(...speeds),
    start_lat: first.lat,
    start_lng: first.lng,
    end_lat: last.lat,
    end_lng: last.lng,
  };
}

/**
 * Pick a `hex_ident` that is free within a scenario.
 *
 * This exists because `PlaybackMap` is keyed by `hex_ident`. The generator can
 * hand back the same hex for two separate generations, and once both are in one
 * scenario they share a clock — one aircraft becomes unreachable, with no error
 * anywhere. Reassigning on collision is the whole fix, and it is silent enough
 * to warrant its own test.
 */
export function uniqueHexIdent(existing: string[], desired: string): string {
  const taken = new Set(existing);
  if (!taken.has(desired)) return desired;

  // Suffix rather than randomise: the id stays recognisably related to the
  // original, which matters when reading a scenario's track list.
  for (let n = 2; ; n += 1) {
    const candidate = `${desired}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

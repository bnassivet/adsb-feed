"use client";
import { createContext, useContext, useCallback, useRef, useState, useMemo, useEffect, ReactNode } from "react";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { AircraftPosition, AircraftTrack } from "@/lib/types";

const TRACK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_POSITIONS = 100; // Max position history per track
const CLEANUP_INTERVAL_MS = 15_000; // TTL cleanup every 15 seconds

interface AircraftTrackingContextValue {
  tracks: Map<string, AircraftTrack>;
  history: Map<string, AircraftTrack>;
  version: number;
}

const AircraftTrackingContext = createContext<AircraftTrackingContextValue | null>(null);

/** Append a position to a track's positions array, capping at MAX_POSITIONS. Mutates in place. */
export function appendPosition(track: AircraftTrack, lat: number, lng: number, altitude: number | null) {
  track.positions.push([lat, lng, altitude]);
  if (track.positions.length > MAX_POSITIONS) {
    track.positions.shift();
  }
}

/** Apply position fields from an incoming message onto an existing track. Mutates in place. */
export function mergePositionInto(track: AircraftTrack, pos: AircraftPosition, now: number) {
  track.callsign = pos.callsign ?? track.callsign;
  track.altitude = pos.altitude ?? track.altitude;
  track.ground_speed = pos.ground_speed ?? track.ground_speed;
  track.track = pos.track ?? track.track;
  track.latitude = pos.latitude ?? track.latitude;
  track.longitude = pos.longitude ?? track.longitude;
  track.vertical_rate = pos.vertical_rate ?? track.vertical_rate;
  track.squawk = pos.squawk ?? track.squawk;
  track.is_on_ground = pos.is_on_ground ?? track.is_on_ground;
  track.timestamp = pos.timestamp;
  track.last_seen = now;
  track.message_count += pos.message_count;

  if (pos.latitude !== null && pos.longitude !== null) {
    appendPosition(track, pos.latitude, pos.longitude, pos.altitude ?? track.altitude);
  }
}

/**
 * Global aircraft tracking provider that keeps running across page navigation.
 * Maintains active tracks and 24-hour history in memory.
 */
export function AircraftTrackingProvider({ children }: { children: ReactNode }) {
  const tracksRef = useRef<Map<string, AircraftTrack>>(new Map());
  const historyRef = useRef<Map<string, AircraftTrack>>(new Map());
  const [updateCounter, setUpdateCounter] = useState(0);

  const handleBatch = useCallback((batch: AircraftPosition[]) => {
    const now = Date.now();
    const map = tracksRef.current;
    const histMap = historyRef.current;

    for (const pos of batch) {
      const existing = map.get(pos.hex_ident);

      if (existing) {
        // Fix 3: mutate in-place instead of allocating a new object
        mergePositionInto(existing, pos, now);
      } else {
        // First sighting — create new track
        const track: AircraftTrack = {
          hex_ident: pos.hex_ident,
          callsign: pos.callsign ?? null,
          altitude: pos.altitude ?? null,
          ground_speed: pos.ground_speed ?? null,
          track: pos.track ?? null,
          latitude: pos.latitude ?? null,
          longitude: pos.longitude ?? null,
          vertical_rate: pos.vertical_rate ?? null,
          squawk: pos.squawk ?? null,
          is_on_ground: pos.is_on_ground ?? null,
          timestamp: pos.timestamp,
          positions: [],
          last_seen: now,
          message_count: pos.message_count,
        };
        if (pos.latitude !== null && pos.longitude !== null) {
          track.positions.push([pos.latitude, pos.longitude, pos.altitude ?? null]);
        }
        map.set(pos.hex_ident, track);
      }

      // Fix 5: consolidated history sync using same helper
      const histEntry = histMap.get(pos.hex_ident);
      if (histEntry) {
        mergePositionInto(histEntry, pos, now);
      }
    }

    setUpdateCounter((c) => c + 1);
  }, []);

  // Fix 6: TTL cleanup on a separate interval instead of every batch
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const map = tracksRef.current;
      const histMap = historyRef.current;
      let changed = false;

      for (const [key, track] of map) {
        if (now - track.last_seen > TRACK_TTL_MS) {
          if (!histMap.has(key)) {
            histMap.set(key, track);
          }
          map.delete(key);
          changed = true;
        }
      }

      for (const [key, track] of histMap) {
        if (now - track.last_seen > HISTORY_TTL_MS) {
          histMap.delete(key);
          changed = true;
        }
      }

      if (changed) {
        setUpdateCounter((c) => c + 1);
      }
    }, CLEANUP_INTERVAL_MS);

    return () => clearInterval(id);
  }, []);

  useTauriEvent<AircraftPosition[]>("adsb:message", handleBatch);

  // Fix 4: memoize context value — only creates new object when updateCounter changes
  const value = useMemo<AircraftTrackingContextValue>(
    () => ({ tracks: tracksRef.current, history: historyRef.current, version: updateCounter }),
    [updateCounter],
  );

  return (
    <AircraftTrackingContext.Provider value={value}>
      {children}
    </AircraftTrackingContext.Provider>
  );
}

/**
 * Hook to access global aircraft tracking data.
 * Must be used within AircraftTrackingProvider.
 */
export function useAircraftTrackingContext() {
  const context = useContext(AircraftTrackingContext);
  if (!context) {
    throw new Error("useAircraftTrackingContext must be used within AircraftTrackingProvider");
  }
  return context;
}

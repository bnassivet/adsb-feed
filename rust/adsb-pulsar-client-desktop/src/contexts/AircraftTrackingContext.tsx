"use client";
import { createContext, useContext, useCallback, useRef, useState, ReactNode } from "react";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { AircraftPosition, AircraftTrack } from "@/lib/types";

const TRACK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_POSITIONS = 100; // Max position history per track

interface AircraftTrackingContextValue {
  tracks: Map<string, AircraftTrack>;
  history: Map<string, AircraftTrack>;
}

const AircraftTrackingContext = createContext<AircraftTrackingContextValue | null>(null);

/**
 * Global aircraft tracking provider that keeps running across page navigation.
 * Maintains active tracks and 6-hour history in memory.
 */
export function AircraftTrackingProvider({ children }: { children: ReactNode }) {
  const tracksRef = useRef<Map<string, AircraftTrack>>(new Map());
  const historyRef = useRef<Map<string, AircraftTrack>>(new Map());
  // Force re-render when maps change (for context consumers)
  const [, setUpdateCounter] = useState(0);

  const handleBatch = useCallback((batch: AircraftPosition[]) => {
    const now = Date.now();
    const map = tracksRef.current;
    const histMap = historyRef.current;

    for (const pos of batch) {
      const existing = map.get(pos.hex_ident);

      const track: AircraftTrack = {
        hex_ident: pos.hex_ident,
        callsign: pos.callsign ?? existing?.callsign ?? null,
        altitude: pos.altitude ?? existing?.altitude ?? null,
        ground_speed: pos.ground_speed ?? existing?.ground_speed ?? null,
        track: pos.track ?? existing?.track ?? null,
        latitude: pos.latitude ?? existing?.latitude ?? null,
        longitude: pos.longitude ?? existing?.longitude ?? null,
        vertical_rate: pos.vertical_rate ?? existing?.vertical_rate ?? null,
        squawk: pos.squawk ?? existing?.squawk ?? null,
        is_on_ground: pos.is_on_ground ?? existing?.is_on_ground ?? null,
        timestamp: pos.timestamp,
        positions: existing?.positions ?? [],
        last_seen: now,
      };

      // Add position to history if we have coordinates
      if (pos.latitude !== null && pos.longitude !== null) {
        track.positions = [
          ...track.positions.slice(-(MAX_POSITIONS - 1)),
          [pos.latitude, pos.longitude],
        ];
      }

      map.set(pos.hex_ident, track);

      // Keep history entry in sync — append position and refresh metadata
      const histEntry = histMap.get(pos.hex_ident);
      if (histEntry) {
        histEntry.callsign = track.callsign;
        histEntry.altitude = track.altitude;
        histEntry.ground_speed = track.ground_speed;
        histEntry.track = track.track;
        histEntry.latitude = track.latitude;
        histEntry.longitude = track.longitude;
        histEntry.vertical_rate = track.vertical_rate;
        histEntry.squawk = track.squawk;
        histEntry.is_on_ground = track.is_on_ground;
        histEntry.last_seen = now;
        if (pos.latitude !== null && pos.longitude !== null) {
          histEntry.positions = [
            ...histEntry.positions.slice(-(MAX_POSITIONS - 1)),
            [pos.latitude, pos.longitude],
          ];
        }
      }
    }

    // Expire old tracks — move to history instead of deleting
    for (const [key, track] of map) {
      if (now - track.last_seen > TRACK_TTL_MS) {
        if (!histMap.has(key)) {
          histMap.set(key, track);
        }
        map.delete(key);
      }
    }

    // Clean history entries older than 6 hours
    for (const [key, track] of histMap) {
      if (now - track.last_seen > HISTORY_TTL_MS) {
        histMap.delete(key);
      }
    }

    // Trigger re-render for context consumers
    setUpdateCounter((c) => c + 1);
  }, []);

  useTauriEvent<AircraftPosition[]>("adsb:message", handleBatch);

  return (
    <AircraftTrackingContext.Provider value={{ tracks: tracksRef.current, history: historyRef.current }}>
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

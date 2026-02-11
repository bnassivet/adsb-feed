"use client";
import { useCallback, useRef, useState } from "react";
import { useTauriEvent } from "./useTauriEvent";
import type { AircraftPosition, AircraftTrack, Filters } from "@/lib/types";

const TRACK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_POSITIONS = 100; // Max position history per track

/**
 * Maintains aircraft track state from `adsb:message` batch events.
 *
 * Merges incoming position updates into accumulated tracks,
 * applies TTL expiry, and filters by user criteria.
 */
export function useAircraftTracks(filters: Filters) {
  const tracksRef = useRef<Map<string, AircraftTrack>>(new Map());
  const [tracks, setTracks] = useState<AircraftTrack[]>([]);

  const handleBatch = useCallback((batch: AircraftPosition[]) => {
    const now = Date.now();
    const map = tracksRef.current;

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
    }

    // Expire old tracks
    for (const [key, track] of map) {
      if (now - track.last_seen > TRACK_TTL_MS) {
        map.delete(key);
      }
    }

    // Apply filters and update state
    const filtered = Array.from(map.values()).filter((t) => {
      if (
        filters.callsign &&
        !(t.callsign ?? "")
          .toLowerCase()
          .includes(filters.callsign.toLowerCase()) &&
        !t.hex_ident.toLowerCase().includes(filters.callsign.toLowerCase())
      ) {
        return false;
      }
      if (t.altitude !== null) {
        if (t.altitude < filters.altitudeMin || t.altitude > filters.altitudeMax) {
          return false;
        }
      }
      if (t.ground_speed !== null) {
        if (t.ground_speed < filters.speedMin || t.ground_speed > filters.speedMax) {
          return false;
        }
      }
      return true;
    });

    setTracks(filtered);
  }, [filters]);

  useTauriEvent<AircraftPosition[]>("adsb:message", handleBatch);

  return tracks;
}

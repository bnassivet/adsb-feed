"use client";
import { useEffect, useRef, useState } from "react";
import { getGroundElevation } from "@/lib/commands";
import { groundQueryKey, groundQueryPoint } from "@/lib/terrain";

export interface UseGroundElevation {
  /** Metres; the last known value while the next one loads. Null without a point. */
  groundM: number | null;
  error: string | null;
}

/**
 * The ground under a (moving) point, read at the centre of its ~200 m cell and
 * asked once per cell; an answer for
 * a cell the point has left is dropped, but the previous height stays shown
 * meanwhile, so the row does not flicker as an aircraft moves.
 */
export function useGroundElevation(point: { lat: number; lng: number } | null): UseGroundElevation {
  const [state, setState] = useState<{ groundM: number | null; error: string | null }>({ groundM: null, error: null });
  // The key asked last, set synchronously: StrictMode's second run asks nothing.
  const asked = useRef<string | null>(null);
  const key = point ? groundQueryKey(point.lat, point.lng) : null;

  useEffect(() => {
    if (key == null) {
      asked.current = null;
      return;
    }
    if (asked.current === key) return;
    asked.current = key;
    const { lat, lng } = groundQueryPoint(key);
    getGroundElevation(lat, lng)
      .then((groundM) => {
        if (asked.current === key) setState({ groundM, error: null });
      })
      .catch((e: unknown) => {
        if (asked.current === key) setState((s) => ({ groundM: s.groundM, error: e instanceof Error ? e.message : String(e) }));
      });
  }, [key]);

  return key == null ? { groundM: null, error: null } : state;
}

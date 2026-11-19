"use client";
import { useEffect, useRef, useState } from "react";
import { getSeamarks } from "@/lib/commands";
import { cellsBounds, type Seamark } from "@/lib/seamark";

const NO_SEAMARKS: Seamark[] = [];

export interface UseSeamarks {
  items: Seamark[];
  loading: boolean;
  error: string | null;
}

/**
 * Seamark descriptions for a set of 2° cells (`seamarkCellsKey` of the view):
 * asked when the set changes, not on every pan. An answer for cells the view
 * has already left is dropped.
 */
export function useSeamarks(enabled: boolean, cellsKey: string | null): UseSeamarks {
  const [state, setState] = useState<{ key: string; items: Seamark[]; error: string | null } | null>(null);
  // The key asked last, set synchronously: StrictMode's second run asks nothing.
  const asked = useRef<string | null>(null);
  const key = enabled ? cellsKey : null;

  useEffect(() => {
    const b = key ? cellsBounds(key) : null;
    if (!key || !b) {
      asked.current = null;
      return;
    }
    if (asked.current === key) return;
    asked.current = key;
    getSeamarks(b.south, b.west, b.north, b.east)
      .then((s) => {
        if (asked.current === key) setState({ key, items: s.items, error: s.error });
      })
      .catch((e: unknown) => {
        if (asked.current === key) setState({ key, items: NO_SEAMARKS, error: e instanceof Error ? e.message : String(e) });
      });
  }, [key]);

  const current = key != null && state?.key === key ? state : null;
  return {
    items: current?.items ?? NO_SEAMARKS,
    loading: key != null && current == null,
    error: current?.error ?? null,
  };
}

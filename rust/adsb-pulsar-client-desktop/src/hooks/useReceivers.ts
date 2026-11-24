"use client";

import { useCallback, useEffect, useState } from "react";
import { listReceivers } from "@/lib/commands";
import type { ReceiverSummary } from "@/lib/types";

/** Receivers move rarely; a minute keeps a remote desktop current enough. */
export const RECEIVERS_REFRESH_MS = 60_000;

/**
 * The receivers the database knows. Empty when storage is unavailable, which
 * is not an error worth showing: the app then runs on its Settings location.
 */
export function useReceivers(refreshMs: number = RECEIVERS_REFRESH_MS) {
  const [receivers, setReceivers] = useState<ReceiverSummary[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setReceivers(await listReceivers());
    } catch {
      setReceivers([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(timer);
  }, [refresh, refreshMs]);

  return { receivers, loaded, refresh };
}

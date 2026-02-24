"use client";
import { useState, useEffect, useCallback } from "react";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { getConfig } from "@/lib/commands";
import { formatWithTz } from "@/lib/format";

export type DisplayTzMode = "local" | "utc" | "source";

/**
 * Reads/writes the user's display timezone preference from localStorage.
 *
 * Returns:
 *   tzMode        — "local" | "utc" | "source"
 *   setTzMode     — setter (persisted to localStorage)
 *   formatTime    — formats epoch ms using the current preference
 *   resolvedTzName — the IANA string for Intl (undefined = machine local)
 */
export function useDisplayTz() {
  const [tzMode, setTzMode] = useLocalStorage<DisplayTzMode>(
    "adsb-display-tz",
    "local",
  );
  const [sourceTzName, setSourceTzName] = useState<string>("Local");

  useEffect(() => {
    getConfig()
      .then((cfg) => setSourceTzName(cfg.dump1090_tz))
      .catch(() => {}); // silent fallback — sourceTzName stays "Local"
  }, []);

  const resolvedTzName: string | undefined =
    tzMode === "utc"
      ? "UTC"
      : tzMode === "source" && sourceTzName !== "Local"
        ? sourceTzName
        : undefined;

  const formatTime = useCallback(
    (ms: number) => formatWithTz(ms, tzMode, sourceTzName),
    [tzMode, sourceTzName],
  );

  return { tzMode, setTzMode, formatTime, resolvedTzName };
}

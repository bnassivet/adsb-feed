"use client";
import { useState, useCallback } from "react";

type SetValue<T> = (value: T | ((prev: T) => T)) => void;

function readStored<T>(key: string, defaultValue: T): T {
  if (typeof window === "undefined") return defaultValue;
  try {
    const stored = localStorage.getItem(key);
    return stored !== null ? (JSON.parse(stored) as T) : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function useLocalStorage<T>(key: string, defaultValue: T): [T, SetValue<T>] {
  // Lazy initialization: read from localStorage synchronously before first render (SSR-safe)
  const [value, setValue] = useState<T>(() => readStored(key, defaultValue));

  // Re-read if the key changes (rare, but defensive). Uses the React "adjust state during render"
  // pattern instead of an effect — keyed on the tracked key so it re-reads exactly once per change.
  const [trackedKey, setTrackedKey] = useState(key);
  if (key !== trackedKey) {
    setTrackedKey(key);
    setValue(readStored(key, defaultValue));
  }

  const setAndPersist: SetValue<T> = useCallback(
    (newValue) => {
      // Functional updater gives the latest value without a render-time ref. The persist is
      // idempotent (same key/value), so running under StrictMode's double-invoke is harmless.
      setValue((prev) => {
        const resolved = typeof newValue === "function" ? (newValue as (prev: T) => T)(prev) : newValue;
        try {
          localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // Ignore storage errors (quota, etc.)
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, setAndPersist];
}

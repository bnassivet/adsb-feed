"use client";
import { useState, useEffect, useCallback, useRef } from "react";

type SetValue<T> = (value: T | ((prev: T) => T)) => void;

export function useLocalStorage<T>(key: string, defaultValue: T): [T, SetValue<T>] {
  // Lazy initialization: read from localStorage synchronously before first render (SSR-safe)
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? (JSON.parse(stored) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });
  const valueRef = useRef(value);
  valueRef.current = value;

  // Keep in sync if key changes (rare, but defensive)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        const parsed = JSON.parse(stored) as T;
        setValue(parsed);
        valueRef.current = parsed;
      }
    } catch {
      // Ignore parse errors, keep current value
    }
  }, [key]);

  const setAndPersist: SetValue<T> = useCallback(
    (newValue) => {
      const resolved = typeof newValue === "function"
        ? (newValue as (prev: T) => T)(valueRef.current)
        : newValue;
      setValue(resolved);
      valueRef.current = resolved;
      try {
        localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        // Ignore storage errors (quota, etc.)
      }
    },
    [key],
  );

  return [value, setAndPersist];
}

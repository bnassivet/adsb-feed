"use client";
import { useState, useEffect, useCallback, useRef } from "react";

type SetValue<T> = (value: T | ((prev: T) => T)) => void;

export function useLocalStorage<T>(key: string, defaultValue: T): [T, SetValue<T>] {
  const [value, setValue] = useState<T>(defaultValue);
  const valueRef = useRef(value);
  valueRef.current = value;

  // Read from localStorage after mount (SSR-safe)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        const parsed = JSON.parse(stored) as T;
        setValue(parsed);
        valueRef.current = parsed;
      }
    } catch {
      // Ignore parse errors, keep default
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

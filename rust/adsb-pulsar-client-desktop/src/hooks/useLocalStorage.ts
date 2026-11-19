"use client";
import { useState, useCallback, useEffect } from "react";

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

/** Fired on `window` when a hook writes a key, so other hooks on it follow. */
const SAME_WINDOW_EVENT = "adsb-local-storage";

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
        // Tell the other hooks on this key, after this update: an updater runs
        // during render, where setting another component's state is not allowed.
        queueMicrotask(() => window.dispatchEvent(new CustomEvent(SAME_WINDOW_EVENT, { detail: key })));
        return resolved;
      });
    },
    [key],
  );

  // Every hook on a key shares its value: a setting changed in one panel (or in
  // another window) shows at once wherever it is used. Each hook re-reads the
  // stored value; an unchanged primitive is a no-op render.
  useEffect(() => {
    const reread = () => setValue(readStored(key, defaultValue));
    const onSameWindow = (e: Event) => {
      if ((e as CustomEvent<string>).detail === key) reread();
    };
    const onOtherWindow = (e: StorageEvent) => {
      if (e.key === key) reread();
    };
    window.addEventListener(SAME_WINDOW_EVENT, onSameWindow);
    window.addEventListener("storage", onOtherWindow);
    return () => {
      window.removeEventListener(SAME_WINDOW_EVENT, onSameWindow);
      window.removeEventListener("storage", onOtherWindow);
    };
    // defaultValue is read only as a fallback; callers pass literals or new objects each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [value, setAndPersist];
}

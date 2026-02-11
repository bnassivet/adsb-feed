"use client";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Subscribes to a Tauri event and calls the handler on each emission.
 * Automatically cleans up the listener on unmount.
 */
export function useTauriEvent<T>(
  event: string,
  handler: (payload: T) => void,
) {
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<T>(event, (e) => handler(e.payload)).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);
}

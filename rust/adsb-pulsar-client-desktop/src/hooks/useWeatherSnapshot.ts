"use client";
import { useEffect, useState } from "react";
import { useTauriEvent } from "./useTauriEvent";
import { getWeatherAvailability, getWeatherSnapshot } from "@/lib/commands";
import type { WeatherAvailability, WeatherSnapshot } from "@/lib/weather";

export interface WeatherState {
  snapshot: WeatherSnapshot | null;
  availability: WeatherAvailability;
}

/**
 * The weather snapshot the backend holds, kept current.
 *
 * Hydrates on mount -- a retained grid can reach the backend before this
 * component exists -- then takes every `adsb:weather` event as the new
 * snapshot, and re-checks availability whenever the feed status changes,
 * since restarting the feed is how the live source (and so weather support)
 * changes.
 */
export function useWeatherSnapshot(): WeatherState {
  const [snapshot, setSnapshot] = useState<WeatherSnapshot | null>(null);
  const [reported, setReported] = useState<WeatherAvailability>("waiting");

  useEffect(() => {
    // Only fills an empty slot: an event may already have delivered a newer
    // snapshot by the time this answer arrives.
    getWeatherSnapshot()
      .then((held) => {
        if (held) setSnapshot((current) => current ?? held);
      })
      .catch(() => {});
    getWeatherAvailability().then(setReported).catch(() => {});
  }, []);

  useTauriEvent<WeatherSnapshot>("adsb:weather", setSnapshot);

  useTauriEvent<unknown>("adsb:status", () => {
    getWeatherAvailability().then(setReported).catch(() => {});
  });

  // The mount-time requests race each other and the event stream, so a
  // "waiting" that lands after a snapshot must not hide it. An unsupported
  // source is never upgraded: a snapshot left from an earlier MQTT session
  // does not mean this session receives weather.
  const availability: WeatherAvailability =
    snapshot && reported === "waiting" ? "available" : reported;

  return { snapshot, availability };
}

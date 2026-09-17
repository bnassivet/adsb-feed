"use client";
import { useCallback, useEffect, useState } from "react";
import { useTauriEvent } from "./useTauriEvent";
import {
  getWeatherAvailability,
  getWeatherService,
  getWeatherSnapshot,
  setWeatherServiceEnabled,
} from "@/lib/commands";
import {
  EMPTY_SERVICE_VIEW,
  type WeatherAvailability,
  type WeatherServiceView,
  type WeatherSnapshot,
} from "@/lib/weather";

/** How long a sent enable/disable waits for the service to report it. */
export const CONFIRM_TIMEOUT_MS = 10_000;

export interface WeatherState {
  snapshot: WeatherSnapshot | null;
  availability: WeatherAvailability;
  /** What the weather service last reported over MQTT. */
  service: WeatherServiceView;
  /** A setting sent to the service and not yet reported back, or null. */
  pendingEnabled: boolean | null;
  /** Why the last enable/disable did not take, or null. */
  serviceError: string | null;
  /** Asks the weather service to enable or disable fetching. */
  setServiceEnabled: (enabled: boolean) => void;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The weather snapshot the backend holds, kept current -- and the weather
 * service's own status, with the command that switches it.
 *
 * Hydrates on mount -- a retained grid can reach the backend before this
 * component exists -- then takes every `adsb:weather` event as the new
 * snapshot, and re-checks availability whenever the feed status changes,
 * since restarting the feed is how the live source (and so weather support)
 * changes.
 *
 * The service follows CQRS. Its status comes only from `adsb:weather-service`
 * (the MQTT status topic). `setServiceEnabled` sends a command and records
 * what was asked for; it never writes the status. The request stays pending
 * until the service reports that setting, or until it times out.
 */
export function useWeatherSnapshot(): WeatherState {
  const [snapshot, setSnapshot] = useState<WeatherSnapshot | null>(null);
  const [reported, setReported] = useState<WeatherAvailability>("waiting");
  const [service, setService] = useState<WeatherServiceView>(EMPTY_SERVICE_VIEW);
  const [requested, setRequested] = useState<boolean | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);

  useEffect(() => {
    // Only fills an empty slot: an event may already have delivered a newer
    // snapshot by the time this answer arrives.
    getWeatherSnapshot()
      .then((held) => {
        if (held) setSnapshot((current) => current ?? held);
      })
      .catch(() => {});
    getWeatherAvailability().then(setReported).catch(() => {});
    getWeatherService()
      .then((view) =>
        setService((current) => (current.status || current.availability ? current : view)),
      )
      .catch(() => {});
  }, []);

  useTauriEvent<WeatherSnapshot>("adsb:weather", setSnapshot);
  useTauriEvent<WeatherServiceView>("adsb:weather-service", setService);

  useTauriEvent<unknown>("adsb:status", () => {
    getWeatherAvailability().then(setReported).catch(() => {});
  });

  // Confirmed: the service reports what was asked for. Cleared during render
  // rather than in an effect, so a later change made elsewhere (the CLI, the
  // chat agent) is never mistaken for a pending request.
  if (requested !== null && service.status?.enabled === requested) {
    setRequested(null);
  }

  useEffect(() => {
    if (requested === null) return;
    const timer = setTimeout(() => {
      setRequested(null);
      setServiceError(
        "No confirmation from the weather service: is it running and connected to the broker?",
      );
    }, CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [requested]);

  const setServiceEnabled = useCallback((enabled: boolean) => {
    setServiceError(null);
    setRequested(enabled);
    setWeatherServiceEnabled(enabled).catch((error: unknown) => {
      setRequested(null);
      setServiceError(errorMessage(error));
    });
  }, []);

  // The mount-time requests race each other and the event stream, so a
  // "waiting" that lands after a snapshot must not hide it. An unsupported
  // source is never upgraded: a snapshot left from an earlier MQTT session
  // does not mean this session receives weather.
  const availability: WeatherAvailability =
    snapshot && reported === "waiting" ? "available" : reported;

  return {
    snapshot,
    availability,
    service,
    pendingEnabled: requested,
    serviceError,
    setServiceEnabled,
  };
}

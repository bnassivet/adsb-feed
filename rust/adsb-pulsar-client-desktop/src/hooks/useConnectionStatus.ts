"use client";
import { useState, useEffect } from "react";
import { useTauriEvent } from "./useTauriEvent";
import { getStatus } from "@/lib/commands";
import type { StatusResponse } from "@/lib/types";

const INITIAL_STATUS: StatusResponse = {
  is_running: false,
  socket_status: { status: "Disconnected" },
  pulsar_status: { status: "Disconnected" },
};

/**
 * Subscribes to `adsb:status` events and returns the latest connection status.
 * Also fetches status on mount so state is correct after navigation.
 */
export function useConnectionStatus(): StatusResponse {
  const [status, setStatus] = useState<StatusResponse>(INITIAL_STATUS);

  // Hydrate from backend on mount (covers navigation / remount)
  useEffect(() => {
    getStatus().then(setStatus).catch(() => {});
  }, []);

  useTauriEvent<StatusResponse>("adsb:status", setStatus);

  return status;
}

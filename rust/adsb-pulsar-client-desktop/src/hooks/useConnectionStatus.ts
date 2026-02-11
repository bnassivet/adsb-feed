"use client";
import { useState } from "react";
import { useTauriEvent } from "./useTauriEvent";
import type { StatusResponse } from "@/lib/types";

const INITIAL_STATUS: StatusResponse = {
  is_running: false,
  socket_status: { status: "Disconnected" },
  pulsar_status: { status: "Disconnected" },
};

/**
 * Subscribes to `adsb:status` events and returns the latest connection status.
 */
export function useConnectionStatus(): StatusResponse {
  const [status, setStatus] = useState<StatusResponse>(INITIAL_STATUS);

  useTauriEvent<StatusResponse>("adsb:status", setStatus);

  return status;
}

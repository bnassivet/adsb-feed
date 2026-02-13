/** Typed wrappers around Tauri invoke() for all backend commands. */
import { invoke } from "@tauri-apps/api/core";
import type { Config, MetricsSnapshot, StatusResponse } from "./types";

export async function startFeed(): Promise<void> {
  return invoke("start_feed");
}

export async function stopFeed(): Promise<void> {
  return invoke("stop_feed");
}

export async function getStatus(): Promise<StatusResponse> {
  return invoke("get_status");
}

export async function getMetrics(): Promise<MetricsSnapshot> {
  return invoke("get_metrics");
}

export async function getConfig(): Promise<Config> {
  return invoke("get_config");
}

export async function saveConfig(config: Config): Promise<void> {
  return invoke("save_config", { config });
}

export async function validateConfig(config: Config): Promise<void> {
  return invoke("validate_config", { config });
}

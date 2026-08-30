/**
 * Client for the agent's non-chat simulation endpoint.
 *
 * The simulation panel submits a form; routing that through the chat pipeline
 * would mean faking a chat turn. `POST /simulate/trajectory` on adsb-agent
 * shares the same A2A client as the `generateSimulatedTrajectory` chat tool, so
 * both entry points behave identically.
 */
import type { AgentTrajectory } from "./simulation-data";

import { AGENT_BASE_URL } from "./agent-url";

// Re-exported: several callers already import it from this module.
export { AGENT_BASE_URL };

export interface SimulateRequest {
  category: "airliner" | "ga" | "helicopter" | "fighter";
  originLat: number;
  originLng: number;
  count?: number;
  routeHint?: string;
  cruiseAltitudeFt?: number;
}

export interface SimulateResponse {
  aircraft: AgentTrajectory[];
  violations: { kind: string; waypoint_index: number; detail: string }[];
  summary: string;
}

/**
 * Request simulated trajectories.
 *
 * @throws Error with a readable message when the agent or the simulation
 *   service behind it is unavailable — callers surface this in the panel.
 */
export async function simulateTrajectory(
  request: SimulateRequest,
  signal?: AbortSignal,
): Promise<SimulateResponse> {
  let response: Response;
  try {
    response = await fetch(`${AGENT_BASE_URL}/simulate/trajectory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (e) {
    throw new Error(
      `Could not reach the agent at ${AGENT_BASE_URL}. Is it running? (${
        e instanceof Error ? e.message : String(e)
      })`,
    );
  }

  if (!response.ok) {
    // FastAPI puts the reason in `detail`; 502 means the simulation agent
    // itself is down behind an otherwise-healthy adsb-agent.
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
      else if (Array.isArray(body?.detail)) detail = "Invalid request parameters";
    } catch {
      /* non-JSON error body — keep the status text */
    }
    throw new Error(detail);
  }

  return (await response.json()) as SimulateResponse;
}

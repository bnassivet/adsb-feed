/**
 * Client for the agent's scenario-description endpoint.
 *
 * The panel's "Generate from trajectories" button sits outside the chat tree
 * and has to work with the chat closed, so — like `simulate-api.ts` — it calls
 * a plain REST endpoint rather than faking a chat turn. `POST /scenario/describe`
 * on adsb-agent makes a single-shot LLM call with no tools and no graph hops.
 *
 * Only the digests are sent, never the raw waypoints: the field names here are
 * the contract with the Python `TrackDigest` model.
 */
import { AGENT_BASE_URL } from "./simulate-api";
import type { TrackDigest } from "./scenario-convert";

interface DescribeResponse {
  description: string;
}

/**
 * Draft a description for a scenario from its tracks.
 *
 * The result is a *draft* — the caller puts it in front of the user to edit and
 * save deliberately. Nothing is persisted by this call.
 *
 * @throws DOMException `AbortError` unchanged when `signal` fires, so callers
 *   can tell a deliberate cancel from a real failure.
 * @throws Error with a readable message when the agent, or the LLM behind it,
 *   is unavailable — the panel renders this inline.
 */
export async function describeScenario(
  name: string,
  tracks: TrackDigest[],
  signal?: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${AGENT_BASE_URL}/scenario/describe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, tracks }),
      signal,
    });
  } catch (e) {
    // A cancel is not a failure. Rethrowing it untouched lets the caller drop
    // it silently instead of showing the user an error they caused on purpose.
    //
    // Duck-typed on `name` rather than `instanceof Error`: fetch rejects an
    // abort with a DOMException, which is NOT an Error instance under jsdom
    // (nor in every browser), so an instanceof guard silently misses it and
    // every deliberate cancel would surface as "agent unreachable".
    if (typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError") {
      throw e;
    }
    throw new Error(
      `Could not reach the agent at ${AGENT_BASE_URL}. Is it running? (${
        e instanceof Error ? e.message : String(e)
      })`,
    );
  }

  if (!response.ok) {
    // FastAPI puts the reason in `detail`; 502 means the LLM endpoint behind an
    // otherwise-healthy adsb-agent is down or returned nothing usable.
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

  const body = (await response.json()) as DescribeResponse;
  return body.description;
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeScenario } from "../scenario-describe-api";
import type { TrackDigest } from "../scenario-convert";

function digest(overrides: Partial<TrackDigest> = {}): TrackDigest {
  return {
    callsign: "HELI01",
    category: "helicopter",
    start_offset_s: 0,
    route: null,
    waypoint_count: 40,
    duration_s: 300,
    phases: ["climb", "cruise"],
    alt_ft_min: 0,
    alt_ft_max: 2500,
    speed_kts_min: 0,
    speed_kts_max: 110,
    start_lat: 45.5,
    start_lng: -73.6,
    end_lat: 45.7,
    end_lng: -73.4,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("describeScenario", () => {
  it("returns the generated description", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ description: "Two aircraft converge." }));

    const result = await describeScenario("Approach Rush", [digest()]);
    expect(result).toBe("Two aircraft converge.");
  });

  it("posts the name and digests to the agent", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ description: "ok" }));

    await describeScenario("Approach Rush", [digest({ callsign: "ACA825" })]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/scenario/describe");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body);
    expect(body.name).toBe("Approach Rush");
    expect(body.tracks).toHaveLength(1);
    expect(body.tracks[0].callsign).toBe("ACA825");
  });

  // The digest is the contract with the Python TrackDigest model: raw waypoints
  // must never be shipped, and the field names must match exactly.
  it("sends the digest fields verbatim, with no waypoints", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ description: "ok" }));

    await describeScenario("S", [digest()]);
    const track = JSON.parse(fetchMock.mock.calls[0][1].body).tracks[0];

    expect(track).toEqual(digest());
    expect(track).not.toHaveProperty("waypoints");
  });

  it("forwards the abort signal so a slow call can be cancelled", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ description: "ok" }));
    const controller = new AbortController();

    await describeScenario("S", [digest()], controller.signal);

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("explains that the agent is unreachable rather than leaking a fetch error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(describeScenario("S", [digest()])).rejects.toThrow(
      /Could not reach the agent/,
    );
  });

  it("names the agent URL in the unreachable message so the user can check it", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(describeScenario("S", [digest()])).rejects.toThrow(/8000/);
  });

  // 502 means adsb-agent is up but the LLM behind it is not — a different fix
  // for the user, so the detail has to survive.
  it("surfaces the FastAPI detail on a 502", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: "the model returned an empty description" }, 502),
    );

    await expect(describeScenario("S", [digest()])).rejects.toThrow(
      /empty description/,
    );
  });

  it("falls back to the status code when the error body is not JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    await expect(describeScenario("S", [digest()])).rejects.toThrow(/500/);
  });

  it("reports a validation array as a readable message", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: [{ loc: ["body", "name"], msg: "field required" }] }, 422),
    );

    await expect(describeScenario("S", [digest()])).rejects.toThrow(
      /Invalid request/,
    );
  });

  it("propagates an abort so the caller can distinguish it from a failure", async () => {
    const abort = new DOMException("Aborted", "AbortError");
    fetchMock.mockRejectedValue(abort);

    // Identity, not just message: the caller checks `name === "AbortError"` to
    // drop it silently, so it must arrive unwrapped.
    await expect(describeScenario("S", [digest()])).rejects.toBe(abort);
  });

  it("sends an empty track list without inventing one", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ description: "An empty scenario." }));

    await describeScenario("Empty", []);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tracks).toEqual([]);
  });
});

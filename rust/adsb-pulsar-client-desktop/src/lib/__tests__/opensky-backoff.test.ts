import { describe, expect, it } from "vitest";
import {
  EMPTY_BACKOFF,
  heldBack,
  NO_DATA_FIRST_RETRY_MS,
  NO_DATA_GIVE_UP_MS,
  pruneBackoff,
  recordPoll,
  type NoDataBackoff,
} from "../opensky-backoff";

const T0 = 1_764_000_000_000;
const asked = (hex: string, at = T0 - 1_000) => new Map([[hex, at]]);

/** One empty answer per probe, each probe made as soon as it is due. */
function emptyProbes(n: number): NoDataBackoff {
  let b = recordPoll(EMPTY_BACKOFF, { pollMs: T0, named: new Set(), asked: asked("3C6444") });
  for (let i = 1; i < n; i++) {
    const due = b.get("3C6444")!.nextProbeMs;
    b = recordPoll(b, { pollMs: due + 1_000, named: new Set(), asked: asked("3C6444", due) });
  }
  return b;
}

describe("recordPoll: exponential backoff on 'no data'", () => {
  it("starts a backoff the first time a poll that covered the aircraft comes back without it", () => {
    const b = recordPoll(EMPTY_BACKOFF, { pollMs: T0, named: new Set(), asked: asked("3C6444") });
    expect(b.get("3C6444")).toEqual({
      sinceMs: T0,
      delayMs: NO_DATA_FIRST_RETRY_MS,
      nextProbeMs: T0 + NO_DATA_FIRST_RETRY_MS,
      stopped: false,
    });
  });

  it("does not count a poll made before the aircraft was asked for", () => {
    const b = recordPoll(EMPTY_BACKOFF, { pollMs: T0, named: new Set(), asked: asked("3C6444", T0 + 1) });
    expect(b.size).toBe(0);
  });

  it("doubles the delay on every empty probe", () => {
    expect(emptyProbes(2).get("3C6444")!.delayMs).toBe(2 * NO_DATA_FIRST_RETRY_MS);
    expect(emptyProbes(3).get("3C6444")!.delayMs).toBe(4 * NO_DATA_FIRST_RETRY_MS);
  });

  it("stops asking once the next probe would fall past 5 min of no data", () => {
    let n = 1;
    while (!emptyProbes(n).get("3C6444")!.stopped) n++;
    const e = emptyProbes(n).get("3C6444")!;
    expect(e.stopped).toBe(true);
    // Every probe made before stopping fell within the five minutes.
    const before = emptyProbes(n - 1).get("3C6444")!;
    expect(before.nextProbeMs - T0).toBeLessThanOrEqual(NO_DATA_GIVE_UP_MS);
    // A handful of probes, not one per poll for five minutes.
    expect(n).toBeLessThanOrEqual(6);
  });

  it("forgets the backoff as soon as OpenSky names the aircraft", () => {
    const b = recordPoll(emptyProbes(3), {
      pollMs: T0 + 200_000,
      named: new Set(["3C6444"]),
      asked: asked("3C6444"),
    });
    expect(b.has("3C6444")).toBe(false);
  });

  it("returns the same map when nothing changed, so React skips the render", () => {
    expect(recordPoll(EMPTY_BACKOFF, { pollMs: T0, named: new Set(), asked: new Map() })).toBe(EMPTY_BACKOFF);
  });
});

describe("heldBack", () => {
  it("holds an aircraft back until its probe is due, and for good once stopped", () => {
    const b = emptyProbes(1);
    expect(heldBack(b, T0 + 1_000)).toEqual(new Set(["3C6444"]));
    expect(heldBack(b, T0 + NO_DATA_FIRST_RETRY_MS)).toEqual(new Set());
    let n = 1;
    while (!emptyProbes(n).get("3C6444")!.stopped) n++;
    expect(heldBack(emptyProbes(n), T0 + 10 * NO_DATA_GIVE_UP_MS)).toEqual(new Set(["3C6444"]));
  });
});

describe("pruneBackoff", () => {
  it("drops an aircraft no longer followed, so following it again starts afresh", () => {
    expect(pruneBackoff(emptyProbes(2), { followed: [], lastLocalMs: () => null }).size).toBe(0);
  });

  it("drops it when the receiver placed it after the backoff began: new information", () => {
    const b = emptyProbes(2);
    expect(pruneBackoff(b, { followed: ["3C6444"], lastLocalMs: () => T0 + 1 }).size).toBe(0);
    expect(pruneBackoff(b, { followed: ["3C6444"], lastLocalMs: () => T0 - 1 })).toBe(b);
  });
});

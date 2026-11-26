import { describe, expect, it, vi } from "vitest";
import { openSkyMenuItems } from "../opensky-menu";
import type { OpenSkyDetails } from "@/components/OpenSkyGapSection";
import type { OpenSkyHistoryDetails } from "@/components/OpenSkyHistorySection";
import type { OpenSkyTrack } from "../opensky";

const TRACK: OpenSkyTrack = { icao24: "3c6444", start_time: 0, end_time: 0, path: [] };

function gap(over: Partial<OpenSkyDetails> = {}): OpenSkyDetails {
  return {
    lastOpenSkyMs: null,
    watched: false,
    followed: false,
    onToggleFollow: vi.fn(),
    followUnavailable: null,
    backfill: null,
    disabledReason: null,
    onBackfill: vi.fn(),
    onClearBackfill: vi.fn(),
    hidden: false,
    onToggleHidden: vi.fn(),
    nowMs: 0,
    ...over,
  };
}

function history(over: Partial<OpenSkyHistoryDetails> = {}): OpenSkyHistoryDetails {
  return {
    entry: null,
    unavailable: null,
    cost: 4,
    onFetch: vi.fn(),
    hidden: false,
    onToggleHidden: vi.fn(),
    onDiscard: vi.fn(),
    ...over,
  };
}

const labels = (items: ReturnType<typeof openSkyMenuItems>) => items.map((i) => i.label);

describe("openSkyMenuItems", () => {
  it("offers following and gap filling on a live aircraft, each acting as the panel does", () => {
    const g = gap();
    const items = openSkyMenuItems({ gap: g, history: null });
    expect(labels(items)).toEqual(["Follow on OpenSky", "Fill gaps (OpenSky), 4 credits"]);
    items[0].onSelect();
    expect(g.onToggleFollow).toHaveBeenCalled();
    items[1].onSelect();
    expect(g.onBackfill).toHaveBeenCalled();
    expect(labels(openSkyMenuItems({ gap: gap({ followed: true }), history: null }))[0]).toBe("Stop following");
  });

  it("offers hiding, showing and discarding a backfill once it is drawn", () => {
    const done = { kind: "done" as const, track: TRACK };
    expect(labels(openSkyMenuItems({ gap: gap({ backfill: done }), history: null }))).toEqual([
      "Follow on OpenSky",
      "Hide OpenSky track",
      "Discard OpenSky track",
    ]);
    expect(labels(openSkyMenuItems({ gap: gap({ backfill: done, hidden: true }), history: null }))[1]).toBe(
      "Show OpenSky track",
    );
  });

  it("offers fetching a recorded flight, then hiding, showing and discarding it", () => {
    const h = history({ cost: 30 });
    const items = openSkyMenuItems({ gap: null, history: h });
    expect(labels(items)).toEqual(["Fetch flight from OpenSky, about 30 credits"]);
    items[0].onSelect();
    expect(h.onFetch).toHaveBeenCalled();
    const entry = { kind: "done" as const, track: TRACK, gaps: { count: 0, seconds: 0, segments: [] }, stored: false };
    expect(labels(openSkyMenuItems({ gap: null, history: history({ entry, hidden: true }) }))).toEqual([
      "Show OpenSky flight",
      "Discard OpenSky flight",
    ]);
  });

  it("greys out what cannot be done, saying why", () => {
    const items = openSkyMenuItems({
      gap: gap({ followUnavailable: "Simulated aircraft", disabledReason: "Simulated aircraft", backfill: null }),
      history: history({ entry: { kind: "loading" } }),
    });
    expect(items.map((i) => [i.label, i.disabled, i.title])).toEqual([
      ["Follow on OpenSky", true, "Simulated aircraft"],
      ["Fill gaps (OpenSky), 4 credits", true, "Simulated aircraft"],
      ["Fetching flight…", true, undefined],
    ]);
  });

  it("offers to turn OpenSky on when the layer is off", () => {
    const on = vi.fn();
    const items = openSkyMenuItems({ gap: null, history: null, onTurnOn: on });
    expect(labels(items)).toEqual(["Turn on OpenSky"]);
    items[0].onSelect();
    expect(on).toHaveBeenCalled();
  });
});

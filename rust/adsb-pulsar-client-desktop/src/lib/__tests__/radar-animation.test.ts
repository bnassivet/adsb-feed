import { describe, it, expect } from "vitest";
import {
  mergeFrames, latestView, animationView, frameDelayMs, nextFrame, formatUtcTime,
  ANIMATION_FRAME_MS, ANIMATION_HOLD_MS, HISTORY_FRAMES, frameOffsetMinutes, formatOffset, type RadarFrames, type RadarSnapshot,
} from "../radar";

const T = Date.UTC(2026, 10, 19, 3, 0);
const min = (m: number) => T + m * 60_000;
const BOUNDS: [number, number, number, number] = [42, -9, 52, 6];

function frames(times: number[], withImage: number[] = times, bounds = BOUNDS): RadarFrames {
  return { bounds, frames: times.map((t) => ({ validTimeMs: t, pngBase64: withImage.includes(t) ? `img${t}` : null })) };
}

describe("mergeFrames", () => {
  it("turns images into data URLs, oldest first", () => {
    const set = mergeFrames(null, frames([min(0), min(5)]));
    expect(set.bounds).toEqual(BOUNDS);
    expect(set.frames).toEqual([
      { validTimeMs: min(0), url: `data:image/png;base64,img${min(0)}` },
      { validTimeMs: min(5), url: `data:image/png;base64,img${min(5)}` },
    ]);
  });

  it("reuses the images it already has, and drops frames that left the hour", () => {
    const first = mergeFrames(null, frames([min(0), min(5)]));
    const next = mergeFrames(first, frames([min(5), min(10)], [min(10)]));
    expect(next.frames.map((f) => f.validTimeMs)).toEqual([min(5), min(10)]);
    expect(next.frames[0].url).toBe(first.frames[1].url);
  });

  it("starts over when the box changes, leaving out frames it has no image for", () => {
    const first = mergeFrames(null, frames([min(0)]));
    const moved = mergeFrames(first, frames([min(0), min(5)], [min(5)], [43, -9, 53, 6]));
    expect(moved.frames.map((f) => f.validTimeMs)).toEqual([min(5)]);
  });
});

describe("views", () => {
  const snapshot: RadarSnapshot = {
    pngBase64: "abc", bounds: BOUNDS, validTimeMs: min(10), accumulationMinutes: 5,
    origin: "download", error: null, scale: [],
  };

  it("shows the latest image alone", () => {
    expect(latestView(snapshot)).toEqual({
      bounds: BOUNDS, images: [{ validTimeMs: min(10), url: "data:image/png;base64,abc" }], shownMs: min(10),
    });
    expect(latestView(null)).toBeNull();
    expect(latestView({ ...snapshot, pngBase64: null })).toBeNull();
  });

  it("shows one frame of the animation, all of them loaded", () => {
    const set = mergeFrames(null, frames([min(0), min(5), min(10)]));
    const v = animationView(set, 1)!;
    expect(v.images).toHaveLength(3);
    expect(v.shownMs).toBe(min(5));
    expect(animationView(set, 7)!.shownMs).toBe(min(10));
    expect(animationView({ bounds: BOUNDS, frames: [] }, 0)).toBeNull();
  });
});

describe("animation timing", () => {
  it("steps through the frames, holds on the newest, then loops", () => {
    expect(frameDelayMs(0, 12)).toBe(ANIMATION_FRAME_MS);
    expect(frameDelayMs(11, 12)).toBe(ANIMATION_HOLD_MS);
    expect(ANIMATION_HOLD_MS).toBeGreaterThan(ANIMATION_FRAME_MS);
    expect(nextFrame(0, 12)).toBe(1);
    expect(nextFrame(11, 12)).toBe(0);
    expect(nextFrame(20, 12)).toBe(0);
  });

  it("an hour is 12 five-minute frames", () => {
    expect(HISTORY_FRAMES).toBe(12);
  });

  it("formats a frame time in UTC", () => {
    expect(formatUtcTime(min(15))).toBe("03:15 UTC");
  });
});

describe("time offset", () => {
  const imgs = [0, 5, 35, 55].map((m) => ({ validTimeMs: min(m), url: "" }));

  it("measures each frame from the newest one", () => {
    expect(frameOffsetMinutes(imgs, 0)).toBe(-55);
    expect(frameOffsetMinutes(imgs, 2)).toBe(-20);
    expect(frameOffsetMinutes(imgs, 3)).toBe(0);
    expect(frameOffsetMinutes([], 0)).toBe(0);
  });

  it("formats the offset", () => {
    expect(formatOffset(0)).toBe("latest");
    expect(formatOffset(-20)).toBe("−20 min");
  });
});

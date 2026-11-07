/**
 * Scale guard for `layoutLabels`. It runs on every feed update (2 Hz) and after
 * every zoom/pan, on the main thread. The first, brute-force version was
 * quadratic: 37 ms at 1,000 aircraft and 92 ms at 3,000, enough to stutter. The budgets
 * below are deliberately loose so a slow CI box does not flake. What they catch
 * is a return to quadratic behaviour, not a few percent of drift.
 */
import { describe, it, expect } from "vitest";
import { layoutLabels, type LabelItem, type LabelPlacement } from "../label-layout";

const VIEW = { width: 1920, height: 1080 };

/** Deterministic LCG so every run lays out the same fleet. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function fleet(onScreen: number, offScreen: number): LabelItem[] {
  const r = rng(42);
  const out: LabelItem[] = [];
  for (let i = 0; i < onScreen + offScreen; i++) {
    const off = i >= onScreen;
    out.push({
      key: `K${i}`,
      x: off ? -100 - r() * 5000 : r() * VIEW.width,
      y: r() * VIEW.height,
      heading: r() * 360,
      text: `A${String(i).padStart(5, "0")}/DAL${i % 9999}`,
      selected: i === 0,
      priority: i,
    });
  }
  return out;
}

/** Mean ms per layout over `runs`, fed its own previous result like the map layer does. */
function timeLayout(items: LabelItem[], runs = 5): { ms: number; result: Map<string, LabelPlacement | null> } {
  let prev = layoutLabels(items, VIEW); // warm-up
  const t0 = performance.now();
  for (let k = 0; k < runs; k++) prev = layoutLabels(items, VIEW, prev);
  return { ms: (performance.now() - t0) / runs, result: prev };
}

type Box = { left: number; top: number; right: number; bottom: number };
const hit = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe("layoutLabels at scale", () => {
  it("lays out 1,000 on-screen aircraft well within a frame budget", () => {
    const { ms } = timeLayout(fleet(1000, 0));
    expect(ms).toBeLessThan(12);
  });

  it("pays almost nothing for aircraft outside the viewport", () => {
    const { ms } = timeLayout(fleet(300, 20000));
    expect(ms).toBeLessThan(6);
  });

  it("keeps every guarantee on a large random fleet", () => {
    const items = fleet(1500, 500);
    const { result } = timeLayout(items, 1);
    const placed: [string, Box][] = [];
    for (const [key, p] of result) {
      if (!p) continue;
      const b = { left: p.left, top: p.top, right: p.left + p.width, bottom: p.top + p.height };
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(VIEW.width);
      expect(b.bottom).toBeLessThanOrEqual(VIEW.height);
      placed.push([key, b]);
    }
    expect(placed.length).toBeGreaterThan(100);
    // No two labels overlap (the selected one may, by design; K0 is selected).
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        if (placed[i][0] === "K0" || placed[j][0] === "K0") continue;
        expect(hit(placed[i][1], placed[j][1])).toBe(false);
      }
    }
    // No label covers another aircraft's icon.
    for (const [key, b] of placed) {
      if (key === "K0") continue;
      for (const it of items) {
        if (it.key === key) continue;
        const half = it.selected ? 18 : 12;
        const icon = { left: it.x - half, top: it.y - half, right: it.x + half, bottom: it.y + half };
        expect(hit(b, icon)).toBe(false);
      }
    }
    // The selected aircraft is always labelled.
    expect(result.get("K0")).not.toBeNull();
  });
});

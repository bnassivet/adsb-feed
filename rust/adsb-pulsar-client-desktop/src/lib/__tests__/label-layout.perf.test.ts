/**
 * Scale guard for `layoutLabels`, which runs on the main thread at 2 Hz and after
 * every zoom/pan.
 *
 * **No absolute millisecond budgets.** They were tried first: the grid ran 4 ms
 * locally and 21 ms on a CI runner, so a budget either fails on slow hardware or
 * is too loose to catch anything. Instead each test times the production grid
 * against `index: "scan"`, the original quadratic full scan, *in the same run on
 * the same machine*, so the machine's speed cancels out. Measured locally: grid
 * 9–10× faster at 1,000 aircraft and 13× with 20,000 off-screen. The thresholds
 * (3×) leave ~3× headroom for noise, while a return to quadratic behaviour
 * (ratio ≈ 1) still fails.
 *
 * The scan also serves as an equivalence oracle: the grid must return
 * *identical* layouts, so the speed-up provably changes nothing visible.
 */
import { describe, it, expect } from "vitest";
import { layoutLabels, type LabelItem } from "../label-layout";

const VIEW = { width: 1920, height: 1080 };
const MIN_SPEEDUP = 3;

/** Deterministic LCG so every run lays out the same fleet. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function fleet(onScreen: number, offScreen: number, seed = 42): LabelItem[] {
  const r = rng(seed);
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

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/**
 * Median ms per layout for the grid and the scan, each fed its own previous
 * result like the map layer does. Runs are **interleaved** (grid, scan, grid,
 * scan, …), so a burst of load on a shared runner lands on both sides rather
 * than skewing one. The median rather than the mean, so one GC pause cannot
 * decide the outcome.
 */
function timeBoth(items: LabelItem[], runs = 7): { grid: number; scan: number } {
  let prevGrid = layoutLabels(items, VIEW); // warm-up
  let prevScan = layoutLabels(items, VIEW, undefined, { index: "scan" });
  const grid: number[] = [];
  const scan: number[] = [];
  for (let k = 0; k < runs; k++) {
    let t0 = performance.now();
    prevGrid = layoutLabels(items, VIEW, prevGrid);
    grid.push(performance.now() - t0);
    t0 = performance.now();
    prevScan = layoutLabels(items, VIEW, prevScan, { index: "scan" });
    scan.push(performance.now() - t0);
  }
  return { grid: median(grid), scan: median(scan) };
}

type Box = { left: number; top: number; right: number; bottom: number };
const hit = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// Explicit timeout: the quadratic reference and the exhaustive checks are slow by
// design, and a loaded CI runner must not hit Vitest's 5 s default.
describe("layoutLabels at scale", { timeout: 30_000 }, () => {
  it("gives exactly the same layout as the full-scan reference", () => {
    const fleets = [fleet(1000, 0), fleet(300, 5000, 7), fleet(1500, 500, 99)];
    for (const items of fleets) {
      const grid = layoutLabels(items, VIEW);
      const scan = layoutLabels(items, VIEW, undefined, { index: "scan" });
      expect(grid).toEqual(scan);
      // And frame-to-frame, with hysteresis in play.
      expect(layoutLabels(items, VIEW, grid)).toEqual(layoutLabels(items, VIEW, scan, { index: "scan" }));
    }
  });

  it(`is at least ${MIN_SPEEDUP}× faster than the full scan at 1,000 on-screen aircraft`, () => {
    const { grid, scan } = timeBoth(fleet(1000, 0));
    expect(scan / grid, `grid ${grid.toFixed(2)} ms vs scan ${scan.toFixed(2)} ms`).toBeGreaterThan(MIN_SPEEDUP);
  });

  it(`is at least ${MIN_SPEEDUP}× faster than the full scan with 20,000 aircraft off-screen`, () => {
    const { grid, scan } = timeBoth(fleet(300, 20000));
    expect(scan / grid, `grid ${grid.toFixed(2)} ms vs scan ${scan.toFixed(2)} ms`).toBeGreaterThan(MIN_SPEEDUP);
  });

  it("keeps every guarantee on a large random fleet", () => {
    const items = fleet(1500, 500);
    const result = layoutLabels(items, VIEW);
    // Violations are collected in plain loops and asserted once: ~10^6 checks
    // through `expect` took over 5 s on a loaded machine; the checks themselves
    // take milliseconds.
    const placed: [string, Box][] = [];
    const violations: string[] = [];
    for (const [key, p] of result) {
      if (!p) continue;
      const b = { left: p.left, top: p.top, right: p.left + p.width, bottom: p.top + p.height };
      if (b.left < 0 || b.top < 0 || b.right > VIEW.width || b.bottom > VIEW.height) {
        violations.push(`${key} leaves the viewport`);
      }
      placed.push([key, b]);
    }
    expect(placed.length).toBeGreaterThan(100);
    // No two labels overlap (the selected one may, by design; K0 is selected).
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        if (placed[i][0] === "K0" || placed[j][0] === "K0") continue;
        if (hit(placed[i][1], placed[j][1])) violations.push(`${placed[i][0]} overlaps ${placed[j][0]}`);
      }
    }
    // No label covers another aircraft's icon.
    for (const [key, b] of placed) {
      if (key === "K0") continue;
      for (const it of items) {
        if (it.key === key) continue;
        const half = it.selected ? 18 : 12;
        const icon = { left: it.x - half, top: it.y - half, right: it.x + half, bottom: it.y + half };
        if (hit(b, icon)) violations.push(`${key} covers ${it.key}'s icon`);
      }
    }
    expect(violations).toEqual([]);
    // The selected aircraft is always labelled.
    expect(result.get("K0")).not.toBeNull();
  });
});

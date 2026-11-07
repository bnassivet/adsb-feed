import { describe, it, expect } from "vitest";
import {
  MESSAGE_TYPES,
  messageTypeKey,
  buildStackedTypeData,
  buildMessageTypeTotals,
  buildPieSlices,
  visibleTypes,
  toggleHiddenType,
  toggleAllHiddenTypes,
  rebaseShares,
} from "../db-history-analytics";
import type { MessageTypeBucket } from "../types";

const B0 = Date.UTC(2024, 0, 15, 10, 0);
const B1 = Date.UTC(2024, 0, 15, 11, 0);

function row(bucket_ms: number, transmission_type: number | null, count: number): MessageTypeBucket {
  return { bucket_ms, transmission_type, count };
}

describe("MESSAGE_TYPES", () => {
  it("covers MSG 1–8 in fixed order, then Other", () => {
    expect(MESSAGE_TYPES.map((t) => t.key)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "other"]);
  });

  it("gives every type a distinct color", () => {
    expect(new Set(MESSAGE_TYPES.map((t) => t.color)).size).toBe(MESSAGE_TYPES.length);
  });
});

describe("messageTypeKey", () => {
  it("maps 1–8 to their own key", () => {
    expect(messageTypeKey(3)).toBe("t3");
  });

  it("folds null and out-of-range types into Other", () => {
    expect(messageTypeKey(null)).toBe("other");
    expect(messageTypeKey(0)).toBe("other");
    expect(messageTypeKey(9)).toBe("other");
  });
});

describe("buildStackedTypeData", () => {
  it("pivots long rows into one zero-filled datum per bucket, with a total", () => {
    const data = buildStackedTypeData([row(B0, 1, 2), row(B0, 3, 5), row(B1, 4, 7), row(B1, null, 1)], "UTC", 0);
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ bucketMs: B0, count: 7, t1: 2, t3: 5, t4: 0, other: 0 });
    expect(data[1]).toMatchObject({ bucketMs: B1, count: 8, t4: 7, other: 1, t1: 0 });
    expect(data[0].label).toBe("10:00");
  });

  it("sorts buckets ascending regardless of row order", () => {
    const data = buildStackedTypeData([row(B1, 3, 1), row(B0, 3, 1)], "UTC", 0);
    expect(data.map((d) => d.bucketMs)).toEqual([B0, B1]);
  });

  it("sums duplicate folds (e.g. null and 9 both into Other)", () => {
    const data = buildStackedTypeData([row(B0, null, 2), row(B0, 9, 3)], "UTC", 0);
    expect(data[0].other).toBe(5);
  });

  it("returns [] for no rows", () => {
    expect(buildStackedTypeData([], "UTC", 0)).toEqual([]);
  });
});

describe("buildMessageTypeTotals", () => {
  it("sums across buckets with percentages, in fixed type order, dropping zero types", () => {
    const totals = buildMessageTypeTotals([row(B0, 3, 6), row(B1, 3, 2), row(B0, 1, 2), row(B1, null, 0)]);
    expect(totals.map((t) => t.key)).toEqual(["t1", "t3"]);
    expect(totals[0]).toMatchObject({ count: 2, pct: 20 });
    expect(totals[1]).toMatchObject({ count: 8, pct: 80 });
  });

  it("keeps each type's color when other types disappear (color follows the entity)", () => {
    const totals = buildMessageTypeTotals([row(B0, 5, 1)]);
    expect(totals[0].color).toBe(MESSAGE_TYPES.find((t) => t.key === "t5")!.color);
  });

  it("returns [] for no rows", () => {
    expect(buildMessageTypeTotals([])).toEqual([]);
  });
});

describe("buildPieSlices", () => {
  const totals = buildMessageTypeTotals([row(B0, 1, 1), row(B0, 3, 3)]); // 25% / 75%

  it("returns one slice per type, clockwise from 12 o'clock, spanning the full circle", () => {
    const slices = buildPieSlices(totals, 50, 50, 40);
    expect(slices.map((s) => s.key)).toEqual(["t1", "t3"]);
    expect(slices[0].startAngle).toBe(0);
    expect(slices[0].endAngle).toBeCloseTo(Math.PI / 2);
    expect(slices[1].startAngle).toBeCloseTo(Math.PI / 2);
    expect(slices[1].endAngle).toBeCloseTo(2 * Math.PI);
  });

  it("draws a quarter slice from the top to 3 o'clock", () => {
    const [q] = buildPieSlices(totals, 50, 50, 40);
    // centre → top (50,10) → arc to right (90,50), small arc, clockwise
    expect(q.path).toBe("M 50 50 L 50 10 A 40 40 0 0 1 90 50 Z");
  });

  it("uses the large-arc flag for slices over half the pie", () => {
    const [, big] = buildPieSlices(totals, 50, 50, 40);
    expect(big.path).toMatch(/A 40 40 0 1 1 /);
  });

  it("marks a lone 100% slice as a full circle (an arc cannot start and end at one point)", () => {
    const [only] = buildPieSlices(buildMessageTypeTotals([row(B0, 4, 9)]), 50, 50, 40);
    expect(only.fullCircle).toBe(true);
  });

  it("returns [] for no totals", () => {
    expect(buildPieSlices([], 50, 50, 40)).toEqual([]);
  });
});

describe("buildPieSlices — donut", () => {
  const totals = buildMessageTypeTotals([row(B0, 1, 1), row(B0, 3, 3)]); // 25% / 75%

  it("cuts an inner hole when given an inner radius", () => {
    const [q] = buildPieSlices(totals, 50, 50, 40, 24);
    // outer arc clockwise top → right, then inner arc back counter-clockwise
    expect(q.path).toBe("M 50 10 A 40 40 0 0 1 90 50 L 74 50 A 24 24 0 0 0 50 26 Z");
  });

  it("exposes each slice's mid angle (for the hover lift)", () => {
    const [q, big] = buildPieSlices(totals, 50, 50, 40, 24);
    expect(q.midAngle).toBeCloseTo(Math.PI / 4);
    expect(big.midAngle).toBeCloseTo(Math.PI / 2 + (3 * Math.PI) / 4);
  });
});

describe("type filter (shared by the stacked histogram and Message Types)", () => {
  const present = buildMessageTypeTotals([row(B0, 1, 1), row(B0, 3, 6), row(B0, 4, 3)]); // t1 10%, t3 60%, t4 30%
  const keys = (xs: { key: string }[]) => xs.map((x) => x.key);

  it("visibleTypes drops hidden types, but never returns an empty set", () => {
    expect(keys(visibleTypes(present, ["t4"]))).toEqual(["t1", "t3"]);
    expect(keys(visibleTypes(present, ["t1", "t3", "t4"]))).toEqual(["t1", "t3", "t4"]);
    expect(keys(visibleTypes(present, ["t8"]))).toEqual(["t1", "t3", "t4"]);
  });

  it("toggleHiddenType hides and re-shows a type", () => {
    expect(toggleHiddenType([], "t4", present)).toEqual(["t4"]);
    expect(toggleHiddenType(["t4"], "t4", present)).toEqual([]);
  });

  it("toggleHiddenType refuses to hide the last visible type", () => {
    expect(toggleHiddenType(["t1", "t3"], "t4", present)).toEqual(["t1", "t3"]);
  });

  it("toggleAllHiddenTypes isolates when every type is on, otherwise shows all", () => {
    expect(toggleAllHiddenTypes([], "t3", present).sort()).toEqual(
      MESSAGE_TYPES.filter((t) => t.key !== "t3").map((t) => t.key).sort(),
    );
    expect(toggleAllHiddenTypes(["t4"], "t1", present)).toEqual([]);
  });

  it("rebaseShares recomputes percentages over the visible types", () => {
    const shown = rebaseShares(visibleTypes(present, ["t4"]));
    expect(shown.map((t) => [t.key, t.pct])).toEqual([
      ["t1", (1 / 7) * 100],
      ["t3", (6 / 7) * 100],
    ]);
  });
});

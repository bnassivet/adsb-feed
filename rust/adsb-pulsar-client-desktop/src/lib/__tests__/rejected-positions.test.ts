import { describe, it, expect } from "vitest";
import { latLngToCell } from "h3-js";
import {
  rejectedKey,
  setShown,
  isShown,
  rejectedCell,
  formatKnots,
} from "../rejected-positions";
import type { RejectedPosition } from "../types";

function row(over: Partial<RejectedPosition> = {}): RejectedPosition {
  return {
    hex_ident: "4CAE9A",
    callsign: null,
    latitude: 83.72,
    longitude: 58.2138,
    altitude: 39000,
    timestamp_ms: 1000,
    source_id: "dev",
    reason: "out_of_range",
    distance_nm: 2402.3,
    rejected_at_ms: 9000,
    implied_speed_kt: null,
    ...over,
  };
}

describe("rejectedKey", () => {
  it("tells apart two fixes of one aircraft at the same instant", () => {
    expect(rejectedKey(row())).not.toBe(rejectedKey(row({ latitude: 83.7 })));
    expect(rejectedKey(row())).toBe(rejectedKey(row({ rejected_at_ms: 1 })));
  });
});

describe("setShown", () => {
  const a = row({ timestamp_ms: 1 });
  const b = row({ timestamp_ms: 2 });
  const c = row({ timestamp_ms: 3 });

  it("adds rows without duplicating those already shown", () => {
    const shown = setShown([a], [a, b], true);
    expect(shown.map((r) => r.timestamp_ms)).toEqual([1, 2]);
  });

  it("hides only the rows it is given", () => {
    const shown = setShown([a, b, c], [b], false);
    expect(shown.map((r) => r.timestamp_ms)).toEqual([1, 3]);
    expect(isShown(shown, b)).toBe(false);
    expect(isShown(shown, a)).toBe(true);
  });
});

describe("formatKnots", () => {
  it("rounds and groups thousands", () => {
    expect(formatKnots(39102.7)).toBe("39,103");
  });
});

describe("rejectedCell", () => {
  it("is the H3 cell holding the fix, as a closed outline", () => {
    const cell = rejectedCell(row(), 5);
    expect(cell?.id).toBe(latLngToCell(83.72, 58.2138, 5));
    expect(cell?.boundary.length).toBeGreaterThanOrEqual(5);
  });

  it("is null without a position", () => {
    expect(rejectedCell(row({ latitude: null }), 5)).toBeNull();
  });
});

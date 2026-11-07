import { describe, it, expect } from "vitest";
import {
  formatTrackLabel,
  trackLabelHtml,
  labelSize,
  layoutLabels,
  candidateAngle,
  CANDIDATES_PER_RING,
  LABEL_CHAR_WIDTH,
  type LabelItem,
  type LabelPlacement,
} from "../label-layout";

const VIEW = { width: 1000, height: 800 };

function item(overrides: Partial<LabelItem> = {}): LabelItem {
  return {
    key: "A1B2C3",
    x: 500,
    y: 400,
    heading: 90,
    text: "A1B2C3/AFR123",
    selected: false,
    priority: 0,
    ...overrides,
  };
}

type Box = { left: number; top: number; right: number; bottom: number };

function box(p: LabelPlacement): Box {
  return { left: p.left, top: p.top, right: p.left + p.width, bottom: p.top + p.height };
}

function intersects(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function iconBox(i: LabelItem): Box {
  const half = i.selected ? 18 : 12;
  return { left: i.x - half, top: i.y - half, right: i.x + half, bottom: i.y + half };
}

/** Smallest angular distance between two bearings, 0..180. */
function angleDiff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

describe("formatTrackLabel", () => {
  it("joins hex ident and callsign with a slash", () => {
    expect(formatTrackLabel({ hex_ident: "4CA2B1", callsign: "RYR12AB" })).toBe("4CA2B1/RYR12AB");
  });

  it("uses '-' when the callsign is missing", () => {
    expect(formatTrackLabel({ hex_ident: "A1B2C3", callsign: null })).toBe("A1B2C3/-");
  });

  it("uses '-' when the callsign is blank, and trims padding", () => {
    expect(formatTrackLabel({ hex_ident: "A1B2C3", callsign: "   " })).toBe("A1B2C3/-");
    expect(formatTrackLabel({ hex_ident: "A1B2C3", callsign: "DAL4  " })).toBe("A1B2C3/DAL4");
  });
});

describe("labelSize", () => {
  it("grows linearly with the text length (monospace)", () => {
    const short = labelSize("A/-");
    const long = labelSize("A1B2C3/AFR1234");
    expect(long.height).toBe(short.height);
    expect(long.width - short.width).toBe(11 * LABEL_CHAR_WIDTH);
  });
});

describe("layoutLabels", () => {
  it("places a lone aircraft's label beside it, never on its trail", () => {
    // Heading east: the trail leaves westward (270°).
    const result = layoutLabels([item({ heading: 90 })], VIEW);
    const p = result.get("A1B2C3")!;
    expect(p).not.toBeNull();
    expect(angleDiff(candidateAngle(p.candidate), 270)).toBeGreaterThanOrEqual(90);
    // Perpendicular to the heading is preferred, right-hand side first (south for an eastbound).
    expect(candidateAngle(p.candidate)).toBe(180);
    expect(p.leader).toBe(false);
  });

  it("keeps the label off the trail as the aircraft turns", () => {
    for (const heading of [0, 45, 135, 200, 315]) {
      const p = layoutLabels([item({ heading })], VIEW).get("A1B2C3")!;
      expect(angleDiff(candidateAngle(p.candidate), heading + 180)).toBeGreaterThanOrEqual(90);
    }
  });

  it("never overlaps the label's own aircraft icon", () => {
    for (let h = 0; h < 360; h += 15) {
      const i = item({ heading: h });
      const p = layoutLabels([i], VIEW).get(i.key)!;
      expect(intersects(box(p), iconBox(i))).toBe(false);
    }
  });

  it("places two close aircraft without their labels touching", () => {
    const a = item({ key: "AAA111", x: 500, y: 400, heading: 90 });
    const b = item({ key: "BBB222", x: 510, y: 412, heading: 90 });
    const result = layoutLabels([a, b], VIEW);
    const pa = result.get("AAA111")!;
    const pb = result.get("BBB222")!;
    expect(pa).not.toBeNull();
    expect(pb).not.toBeNull();
    expect(intersects(box(pa), box(pb))).toBe(false);
  });

  it("does not put a label over another aircraft's icon", () => {
    // B sits exactly in A's preferred (south) slot.
    const a = item({ key: "AAA111", x: 500, y: 400, heading: 90 });
    const b = item({ key: "BBB222", x: 500, y: 430, heading: 90 });
    const result = layoutLabels([a, b], VIEW);
    for (const [key, p] of result) {
      if (!p) continue;
      for (const other of [a, b]) {
        if (other.key === key) continue;
        expect(intersects(box(p), iconBox(other))).toBe(false);
      }
    }
  });

  it("hides the surplus in a dense cluster but never lets two labels overlap", () => {
    const items: LabelItem[] = [];
    for (let i = 0; i < 40; i++) {
      items.push(item({
        key: `K${i}`,
        x: 500 + (i % 8) * 6,
        y: 400 + Math.floor(i / 8) * 6,
        heading: (i * 37) % 360,
        priority: i,
      }));
    }
    const result = layoutLabels(items, VIEW);
    const placed = [...result.values()].filter((p): p is LabelPlacement => p !== null);
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.length).toBeLessThan(items.length);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(intersects(box(placed[i]), box(placed[j]))).toBe(false);
      }
    }
  });

  it("always places a selected aircraft's label, ahead of higher-priority ones", () => {
    const items: LabelItem[] = [];
    for (let i = 0; i < 40; i++) {
      items.push(item({ key: `K${i}`, x: 500 + (i % 8) * 6, y: 400 + Math.floor(i / 8) * 6, priority: 100 - i }));
    }
    items[39] = { ...items[39], selected: true, priority: -1 };
    const result = layoutLabels(items, VIEW);
    expect(result.get("K39")).not.toBeNull();
  });

  it("gives the most recently seen aircraft priority", () => {
    const old = item({ key: "OLD", x: 500, y: 400, priority: 1 });
    const fresh = item({ key: "NEW", x: 500, y: 400, priority: 2 });
    // Same position: preferred slot goes to the higher priority.
    const result = layoutLabels([old, fresh], VIEW);
    const pNew = result.get("NEW")!;
    expect(candidateAngle(pNew.candidate)).toBe(180);
    expect(pNew.leader).toBe(false);
  });

  it("is deterministic and keeps the previous slot when it is still free", () => {
    const first = layoutLabels([item()], VIEW);
    const again = layoutLabels([item()], VIEW, first);
    expect(again.get("A1B2C3")!.candidate).toBe(first.get("A1B2C3")!.candidate);

    // Force a non-preferred slot, then show it sticks after a small move and a slight turn.
    const forcedPrev = new Map([["A1B2C3", { ...first.get("A1B2C3")!, candidate: 0 }]]);
    const moved = layoutLabels([item({ x: 503, y: 401, heading: 100 })], VIEW, forcedPrev);
    expect(moved.get("A1B2C3")!.candidate).toBe(0);
  });

  it("moves off the previous slot once it collides", () => {
    const first = layoutLabels([item({ key: "A" })], VIEW);
    const slot = first.get("A")!;
    // A higher-priority aircraft parks its icon in the middle of A's previous label box.
    const blocker = item({
      key: "B",
      x: slot.left + slot.width / 2,
      y: slot.top + slot.height / 2,
      priority: 10,
    });
    const next = layoutLabels([item({ key: "A" }), blocker], VIEW, first);
    const a = next.get("A")!;
    expect(a).not.toBeNull();
    expect(a.candidate).not.toBe(slot.candidate);
    expect(intersects(box(a), iconBox(blocker))).toBe(false);
  });

  it("never chooses a box that leaves the viewport", () => {
    const corners = [
      item({ key: "TL", x: 2, y: 2, heading: 315 }),
      item({ key: "BR", x: VIEW.width - 2, y: VIEW.height - 2, heading: 135 }),
      item({ key: "R", x: VIEW.width - 5, y: 400, heading: 90 }),
    ];
    const result = layoutLabels(corners, VIEW);
    for (const p of result.values()) {
      if (!p) continue;
      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.top).toBeGreaterThanOrEqual(0);
      expect(p.left + p.width).toBeLessThanOrEqual(VIEW.width);
      expect(p.top + p.height).toBeLessThanOrEqual(VIEW.height);
    }
  });

  it("skips aircraft outside the viewport", () => {
    const result = layoutLabels([item({ key: "OUT", x: -50, y: 400 })], VIEW);
    expect(result.get("OUT")).toBeNull();
  });

  it("reports offsets relative to the aircraft, and a leader only on the outer ring", () => {
    const i = item();
    const p = layoutLabels([i], VIEW).get(i.key)!;
    expect(p.dx).toBe(p.left - i.x);
    expect(p.dy).toBe(p.top - i.y);
    expect(p.candidate).toBeLessThan(CANDIDATES_PER_RING);

    // Fill the inner ring with other icons so only the outer ring is free.
    const blockers: LabelItem[] = [];
    for (let k = 0; k < CANDIDATES_PER_RING; k++) {
      const a = (k * 360) / CANDIDATES_PER_RING;
      blockers.push(item({
        key: `B${k}`,
        x: 500 + 26 * Math.sin((a * Math.PI) / 180),
        y: 400 - 26 * Math.cos((a * Math.PI) / 180),
        priority: -10,
        text: "",
      }));
    }
    const outer = layoutLabels([item({ priority: 100 }), ...blockers], VIEW).get("A1B2C3");
    expect(outer).not.toBeNull();
    expect(outer!.candidate).toBeGreaterThanOrEqual(CANDIDATES_PER_RING);
    expect(outer!.leader).toBe(true);
  });

  it("handles an unknown heading", () => {
    const p = layoutLabels([item({ heading: null })], VIEW).get("A1B2C3");
    expect(p).not.toBeNull();
  });
});

describe("trackLabelHtml", () => {
  const inner = layoutLabels([item()], VIEW).get("A1B2C3")!;

  it("positions the chip at the placement offset with its exact width", () => {
    const html = trackLabelHtml(inner, "A1B2C3/AFR123", "#22d3ee", false, "dark");
    expect(html).toContain(`left:${inner.dx}px`);
    expect(html).toContain(`top:${inner.dy}px`);
    expect(html).toContain(`width:${inner.width}px`);
    expect(html).toContain("A1B2C3/AFR123");
    expect(html).not.toContain("<line");
  });

  it("escapes the text", () => {
    const html = trackLabelHtml(inner, "A1B2C3/<b>&", "#fff", false, "dark");
    expect(html).toContain("A1B2C3/&lt;b&gt;&amp;");
    expect(html).not.toContain("<b>");
  });

  it("draws a leader line from the icon edge to the box on the outer ring", () => {
    const outer: LabelPlacement = { ...inner, candidate: 10, leader: true, lx: 40, ly: 0 };
    const html = trackLabelHtml(outer, "X/-", "#fff", false, "dark");
    expect(html).toContain("<line");
    expect(html).toContain('x1="12"');
    expect(html).toContain('x2="40"');
  });

  it("is bold when selected and adapts to the light theme", () => {
    expect(trackLabelHtml(inner, "X/-", "#fff", true, "dark")).toContain("font-weight:700");
    const light = trackLabelHtml(inner, "X/-", "#f59e0b", false, "light");
    expect(light).toContain("border-left:2px solid #f59e0b");
  });
});

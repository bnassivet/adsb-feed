import { describe, expect, it } from "vitest";
import { windBarbSvg } from "../wind-barb";

function parse(svg: string): Document {
  return new DOMParser().parseFromString(svg, "image/svg+xml");
}

function count(svg: string, tag: string): number {
  return parse(svg).getElementsByTagName(tag).length;
}

/** Length of a line element. */
function lineLength(line: Element): number {
  const n = (a: string) => Number(line.getAttribute(a));
  return Math.hypot(n("x2") - n("x1"), n("y2") - n("y1"));
}

describe("windBarbSvg", () => {
  it("is well-formed SVG", () => {
    const doc = parse(windBarbSvg({ dirDeg: 250, speedKt: 65 }, "#38bdf8"));
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(doc.documentElement.tagName).toBe("svg");
  });

  it("draws a calm wind as a circle with no shaft", () => {
    const svg = windBarbSvg({ dirDeg: 0, speedKt: 2 }, "#fff");
    expect(count(svg, "circle")).toBe(1);
    expect(count(svg, "line")).toBe(0);
  });

  it("draws 5 kt as a shaft and a half barb", () => {
    const svg = windBarbSvg({ dirDeg: 90, speedKt: 5 }, "#fff");
    const lines = Array.from(parse(svg).getElementsByTagName("line"));
    expect(lines).toHaveLength(2);
    expect(count(svg, "polygon")).toBe(0);
    // The shaft is the longest line; the half barb is shorter than the shaft.
    const [shaft, half] = [...lines].sort((a, b) => lineLength(b) - lineLength(a));
    expect(lineLength(half)).toBeLessThan(lineLength(shaft));
  });

  it("draws 65 kt as a pennant, a full barb and a half barb", () => {
    const svg = windBarbSvg({ dirDeg: 250, speedKt: 65 }, "#fff");
    expect(count(svg, "polygon")).toBe(1);
    // shaft + full + half
    expect(count(svg, "line")).toBe(3);
  });

  it("draws 125 kt as two pennants, two full barbs and a half barb", () => {
    const svg = windBarbSvg({ dirDeg: 250, speedKt: 123 }, "#fff");
    expect(count(svg, "polygon")).toBe(2);
    expect(count(svg, "line")).toBe(4);
  });

  it("makes a half barb shorter than a full barb", () => {
    const svg = windBarbSvg({ dirDeg: 0, speedKt: 15 }, "#fff");
    const lines = Array.from(parse(svg).getElementsByTagName("line")).map(lineLength);
    const [shaft, full, half] = [...lines].sort((a, b) => b - a);
    expect(shaft).toBeGreaterThan(full);
    expect(full).toBeGreaterThan(half);
  });

  it("rotates the glyph to the direction the wind blows from", () => {
    const svg = windBarbSvg({ dirDeg: 250, speedKt: 40 }, "#fff", 32);
    expect(svg).toContain("rotate(250 16 16)");
  });

  it("strokes in the given colour", () => {
    expect(windBarbSvg({ dirDeg: 0, speedKt: 20 }, "#f97316")).toContain('stroke="#f97316"');
  });

  it("uses the requested size", () => {
    const doc = parse(windBarbSvg({ dirDeg: 0, speedKt: 20 }, "#fff", 40));
    expect(doc.documentElement.getAttribute("width")).toBe("40");
    expect(doc.documentElement.getAttribute("height")).toBe("40");
  });
});

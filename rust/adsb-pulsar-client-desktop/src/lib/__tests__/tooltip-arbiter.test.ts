import { describe, it, expect, vi, beforeEach } from "vitest";
import L from "leaflet";
import { DotTooltipArbiter } from "../tooltip-arbiter";

const tick = () => new Promise<void>((r) => queueMicrotask(r));

function path() {
  const p = L.polygon([[45, -73], [45.1, -73], [45.1, -73.1]]);
  return Object.assign(p, {
    closeTooltip: vi.fn(() => p),
    openTooltip: vi.fn(() => p),
  });
}

describe("DotTooltipArbiter", () => {
  let map: L.Evented;
  let arb: DotTooltipArbiter;
  const open = (source: L.Layer) => map.fire("tooltipopen", { tooltip: { _source: source } });
  const close = (source: L.Layer) => map.fire("tooltipclose", { tooltip: { _source: source } });
  const cursor = L.latLng(45.05, -73.05);

  beforeEach(() => {
    // A bare event bus stands in for the map: the arbiter only listens on it.
    map = new (L.Evented as unknown as new () => L.Evented)();
    arb = new DotTooltipArbiter(map as unknown as L.Map);
  });

  it("leaves path tooltips alone while no dot is hovered", async () => {
    const hex = path();
    open(hex);
    await tick();
    expect(hex.closeTooltip).not.toHaveBeenCalled();
  });

  it("closes a path tooltip that opens while a dot is hovered, and restores it after", async () => {
    const hex = path();
    arb.setDotActive(true);
    open(hex);
    await tick();
    expect(hex.closeTooltip).toHaveBeenCalledTimes(1);
    arb.setDotActive(false, cursor);
    expect(hex.openTooltip).toHaveBeenCalledWith(cursor);
  });

  it("closes path tooltips already open when a dot becomes hovered", () => {
    const line = path();
    open(line);
    arb.setDotActive(true);
    expect(line.closeTooltip).toHaveBeenCalledTimes(1);
  });

  it("does not track a path tooltip that already closed", () => {
    const line = path();
    open(line);
    close(line);
    arb.setDotActive(true);
    expect(line.closeTooltip).not.toHaveBeenCalled();
  });

  it("does not restore a path the pointer has left", async () => {
    const hex = path();
    arb.setDotActive(true);
    open(hex);
    await tick();
    hex.fire("mouseout");
    arb.setDotActive(false, cursor);
    expect(hex.openTooltip).not.toHaveBeenCalled();
  });

  it("restores nothing when the pointer left the map (no cursor)", async () => {
    const hex = path();
    arb.setDotActive(true);
    open(hex);
    await tick();
    arb.setDotActive(false);
    expect(hex.openTooltip).not.toHaveBeenCalled();
    arb.setDotActive(true);
    arb.setDotActive(false, cursor);
    expect(hex.openTooltip).not.toHaveBeenCalled();
  });

  it("never touches marker tooltips (icons own their hover)", async () => {
    const icon = Object.assign(L.marker([45, -73]), { closeTooltip: vi.fn() });
    arb.setDotActive(true);
    open(icon);
    await tick();
    expect(icon.closeTooltip).not.toHaveBeenCalled();
  });

  it("ignores tooltips with no source (the dot's own)", async () => {
    arb.setDotActive(true);
    expect(() => map.fire("tooltipopen", { tooltip: {} })).not.toThrow();
    await tick();
  });

  it("stops listening when disposed", async () => {
    const hex = path();
    arb.dispose();
    arb.setDotActive(true);
    open(hex);
    await tick();
    expect(hex.closeTooltip).not.toHaveBeenCalled();
  });
});

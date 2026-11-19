import { describe, it, expect } from "vitest";
import { qnhAltitudeFt, nearestQnh, mslAltitude, DEFAULT_TRANSITION_ALTITUDE_FT, type QnhSource } from "../qnh";
import { normalizeMetar, type Metar } from "../metar";

describe("qnhAltitudeFt", () => {
  it("is the pressure altitude when QNH is standard", () => {
    expect(qnhAltitudeFt(5000, 1013.25)).toBeCloseTo(5000, 6);
  });

  it("adds about 27 ft per hPa above standard near sea level", () => {
    // ISA: at QNH 1027.2 an altimeter reads ~378 ft where pressure altitude is 0.
    expect(qnhAltitudeFt(0, 1027.2)).toBeCloseTo(378, 0);
    // The correction shrinks slightly with height (~370 ft at 3000 ft): the
    // same pressure difference is a thicker layer of air lower down.
    const atSea = qnhAltitudeFt(0, 1027.2);
    const at3000 = qnhAltitudeFt(3000, 1027.2) - 3000;
    expect(at3000).toBeCloseTo(370, 0);
    expect(at3000).toBeLessThan(atSea);
  });

  it("subtracts below standard: high to low, look out below", () => {
    expect(qnhAltitudeFt(2000, 990)).toBeLessThan(2000 - 600);
  });
});

function station(id: string, lat: number, lon: number, over: Record<string, unknown> = {}): Metar {
  return normalizeMetar({ icaoId: id, lat, lon, obsTime: 1_800_000_000, altim: 1020, ...over })!;
}
const NOW = 1_800_000_000_000 + 20 * 60_000;

describe("nearestQnh", () => {
  const list = [station("FAR", 47, -73.6, { altim: 1000 }), station("NEAR", 45.6, -73.6, { altim: 1027.2 })];

  it("takes the nearest station with a QNH", () => {
    const q = nearestQnh(list, 45.5, -73.6, NOW)!;
    expect(q.stationId).toBe("NEAR");
    expect(q.qnhHpa).toBe(1027.2);
    expect(q.distanceNm).toBeCloseTo(6, 0);
  });

  it("skips stations without QNH and old reports", () => {
    const noQnh = station("NOQ", 45.5, -73.6, { altim: null });
    const old = station("OLD", 45.51, -73.6, { obsTime: 1_800_000_000 - 4 * 3600 });
    expect(nearestQnh([noQnh, old, ...list], 45.5, -73.6, NOW)!.stationId).toBe("NEAR");
  });

  it("gives up beyond the maximum distance", () => {
    expect(nearestQnh(list, 30, -73.6, NOW)).toBeNull();
    expect(nearestQnh([], 45.5, -73.6, NOW)).toBeNull();
  });
});

describe("mslAltitude", () => {
  const q: QnhSource = { qnhHpa: 1027.2, stationId: "CYUL", distanceNm: 3 };

  it("corrects below the transition altitude", () => {
    expect(mslAltitude(3000, q)).toBe(Math.round(qnhAltitudeFt(3000, 1027.2)));
  });

  it("does not correct at or above the transition altitude: flight levels are the reference there", () => {
    expect(mslAltitude(DEFAULT_TRANSITION_ALTITUDE_FT, q)).toBeNull();
    expect(mslAltitude(35000, q)).toBeNull();
  });

  it("defaults to the usual French transition altitude, 5000 ft", () => {
    expect(DEFAULT_TRANSITION_ALTITUDE_FT).toBe(5000);
    expect(mslAltitude(4900, q)).not.toBeNull();
    expect(mslAltitude(6000, q)).toBeNull();
  });

  it("takes another transition altitude (e.g. 18,000 ft in North America)", () => {
    expect(mslAltitude(12000, q, 18000)).toBe(Math.round(qnhAltitudeFt(12000, 1027.2)));
    expect(mslAltitude(18000, q, 18000)).toBeNull();
  });

  it("needs an altitude and a QNH", () => {
    expect(mslAltitude(null, q)).toBeNull();
    expect(mslAltitude(3000, null)).toBeNull();
  });
});

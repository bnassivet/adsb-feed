import { describe, expect, it } from "vitest";
import { formatAlongTrack, formatCrosswind, formatWind, formatWindDirection } from "../wind-format";

describe("formatWindDirection", () => {
  it("pads to three digits", () => {
    expect(formatWindDirection(70)).toBe("070°");
    expect(formatWindDirection(5)).toBe("005°");
    expect(formatWindDirection(250)).toBe("250°");
  });

  it("writes north as 360, including values that round to it", () => {
    expect(formatWindDirection(0)).toBe("360°");
    expect(formatWindDirection(0.4)).toBe("360°");
    expect(formatWindDirection(359.7)).toBe("360°");
  });
});

describe("formatWind", () => {
  it("combines direction and rounded speed", () => {
    expect(formatWind({ dirDeg: 250.4, speedKt: 98.6 })).toBe("250° / 99 kt");
  });
});

describe("formatAlongTrack", () => {
  it("names a positive component a headwind and a negative one a tailwind", () => {
    expect(formatAlongTrack({ headwindKt: 85.2, crosswindKt: 0 })).toBe("85 kt headwind");
    expect(formatAlongTrack({ headwindKt: -40, crosswindKt: 0 })).toBe("40 kt tailwind");
  });

  it("says none when it rounds to zero, whatever its sign", () => {
    expect(formatAlongTrack({ headwindKt: -0.4, crosswindKt: 0 })).toBe("no headwind");
  });
});

describe("formatCrosswind", () => {
  it("names the side the wind comes from", () => {
    expect(formatCrosswind({ headwindKt: 0, crosswindKt: -49.3 })).toBe("49 kt from the left");
    expect(formatCrosswind({ headwindKt: 0, crosswindKt: 20.4 })).toBe("20 kt from the right");
  });

  it("says none when it rounds to zero", () => {
    expect(formatCrosswind({ headwindKt: 0, crosswindKt: 0.3 })).toBe("no crosswind");
  });
});

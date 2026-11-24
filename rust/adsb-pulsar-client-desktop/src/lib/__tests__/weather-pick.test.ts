import { describe, it, expect } from "vitest";
import { pickWeatherSnapshot, type WeatherSnapshot } from "@/lib/weather";

const snap = (valid: number) => ({ valid_time_ms: valid }) as WeatherSnapshot;

describe("pickWeatherSnapshot", () => {
  it("takes the receiver's own grid when there is one", () => {
    expect(pickWeatherSnapshot(snap(1), { "pi-a": snap(2) }, "pi-a")?.valid_time_ms).toBe(2);
  });

  it("falls back to the shared grid", () => {
    expect(pickWeatherSnapshot(snap(1), { "pi-a": snap(2) }, "pi-b")?.valid_time_ms).toBe(1);
    expect(pickWeatherSnapshot(snap(1), {}, null)?.valid_time_ms).toBe(1);
    expect(pickWeatherSnapshot(null, {}, "pi-a")).toBeNull();
  });
});

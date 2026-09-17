import { describe, expect, it } from "vitest";
import {
  EMPTY_SERVICE_VIEW,
  describeServiceStatus,
  serviceToggleView,
  type WeatherServiceStatus,
  type WeatherServiceView,
} from "../weather";

const NOW = 1_789_412_400_000;
const MIN = 60_000;

function status(overrides: Partial<WeatherServiceStatus> = {}): WeatherServiceStatus {
  return {
    version: 1,
    enabled: true,
    state: "idle",
    consecutive_failures: 0,
    rate_limit: null,
    last_success_ms: NOW - 10 * MIN,
    last_error: null,
    next_fetch_ms: NOW + 25 * MIN,
    snapshot_valid_time_ms: NOW,
    updated_at_ms: NOW,
    ...overrides,
  };
}

function online(s: WeatherServiceStatus): WeatherServiceView {
  return { status: s, availability: "online" };
}

describe("describeServiceStatus", () => {
  it("says nothing before the service has been heard from", () => {
    expect(describeServiceStatus(EMPTY_SERVICE_VIEW, NOW)).toBeNull();
  });

  it("reports an up-to-date service and when it fetches next", () => {
    expect(describeServiceStatus(online(status()), NOW)).toEqual({
      text: "Service up to date · next Open-Meteo fetch in 25 min",
      tone: "ok",
    });
  });

  it("reports the service's pause, not the desktop's", () => {
    // The desktop fetches nothing: it hears the service over MQTT. The line
    // must say who paused, and that the map keeps what it last received.
    expect(
      describeServiceStatus(online(status({ enabled: false, state: "disabled" })), NOW),
    ).toEqual({
      text: "Service paused: not fetching from Open-Meteo · map keeps its last grid",
      tone: "warn",
    });
  });

  it("reports a fetch in flight as the service's", () => {
    expect(describeServiceStatus(online(status({ state: "fetching" })), NOW)).toEqual({
      text: "Service fetching from Open-Meteo…",
      tone: "ok",
    });
  });

  it("never describes an action without saying who acts", () => {
    const states = ["idle", "fetching", "retrying", "rate_limited", "rejected", "disabled"] as const;
    for (const state of states) {
      const line = describeServiceStatus(online(status({ state })), NOW);
      expect(line?.text, state).toMatch(/service|open-meteo/i);
    }
  });

  it("reports repeated failures with the retry time", () => {
    const line = describeServiceStatus(
      online(status({ state: "retrying", consecutive_failures: 3, next_fetch_ms: NOW + 4 * MIN })),
      NOW,
    );
    expect(line).toEqual({
      text: "Open-Meteo fetch failing (3×) · service retries in 4 min",
      tone: "warn",
    });
  });

  it("names the rate limit that was hit and when it will try again", () => {
    const line = describeServiceStatus(
      online(status({ state: "rate_limited", rate_limit: "daily", next_fetch_ms: NOW + 360 * MIN })),
      NOW,
    );
    expect(line).toEqual({
      text: "Open-Meteo daily limit reached · service retries in 6 h",
      tone: "warn",
    });
  });

  it("shows why a request was rejected", () => {
    const line = describeServiceStatus(
      online(status({ state: "rejected", last_error: "Cannot initialize WeatherVariable" })),
      NOW,
    );
    expect(line?.text).toBe(
      "Open-Meteo rejected the service's request: Cannot initialize WeatherVariable",
    );
    expect(line?.tone).toBe("error");
  });

  it("reports an offline service with what it was last doing", () => {
    const view: WeatherServiceView = {
      status: status({ enabled: false, state: "disabled" }),
      availability: "offline",
    };
    expect(describeServiceStatus(view, NOW)).toEqual({
      text: "Weather service offline (was paused)",
      tone: "error",
    });
  });

  it("reports an offline service that never sent a status", () => {
    expect(describeServiceStatus({ status: null, availability: "offline" }, NOW)?.text).toBe(
      "Weather service offline",
    );
  });

  it("says now when the next fetch is due", () => {
    expect(describeServiceStatus(online(status({ next_fetch_ms: NOW - MIN })), NOW)?.text).toBe(
      "Service up to date · next Open-Meteo fetch now",
    );
  });
});

describe("serviceToggleView", () => {
  it("is off and unusable when the live source is not MQTT", () => {
    expect(serviceToggleView("unsupported_source", online(status()), null)).toMatchObject({
      checked: false,
      disabled: true,
    });
  });

  it("is unusable, and says why, before any status arrives", () => {
    const view = serviceToggleView("waiting", EMPTY_SERVICE_VIEW, null);
    expect(view.disabled).toBe(true);
    expect(view.reason).toMatch(/no status/i);
  });

  it("follows the service's reported setting", () => {
    expect(serviceToggleView("available", online(status({ enabled: true })), null)).toEqual({
      checked: true,
      disabled: false,
      pending: false,
      reason: null,
    });
    expect(serviceToggleView("available", online(status({ enabled: false })), null).checked).toBe(
      false,
    );
  });

  it("moves at once but stays locked while a request is pending", () => {
    const view = serviceToggleView("available", online(status({ enabled: true })), false);
    expect(view).toEqual({ checked: false, disabled: true, pending: true, reason: null });
  });

  it("settles when the service reports the requested setting", () => {
    const view = serviceToggleView("available", online(status({ enabled: false })), false);
    expect(view.pending).toBe(false);
    expect(view.disabled).toBe(false);
  });

  it("cannot command an offline service", () => {
    const view = serviceToggleView("available", { status: status(), availability: "offline" }, null);
    expect(view.disabled).toBe(true);
    expect(view.checked).toBe(true);
  });
});

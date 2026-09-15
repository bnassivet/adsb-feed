import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WeatherControls, type WeatherControlsProps } from "../WeatherControls";
import type { WeatherServiceStatus, WeatherServiceView } from "@/lib/weather";

const MIN = 60_000;

function service(overrides: Partial<WeatherServiceStatus> = {}): WeatherServiceView {
  return {
    status: {
      version: 1,
      enabled: true,
      state: "idle",
      consecutive_failures: 0,
      rate_limit: null,
      last_success_ms: 0,
      last_error: null,
      next_fetch_ms: null,
      snapshot_valid_time_ms: 0,
      updated_at_ms: 0,
      ...overrides,
    },
    availability: "online",
  };
}

function props(overrides: Partial<WeatherControlsProps> = {}): WeatherControlsProps {
  return {
    show: true,
    onToggle: vi.fn(),
    level: 250,
    onLevelChange: vi.fn(),
    showBarbs: true,
    onToggleBarbs: vi.fn(),
    showParticles: false,
    onToggleParticles: vi.fn(),
    levels: [850, 700, 500, 300, 250, 200],
    availability: "available",
    validTimeMs: 0,
    stale: false,
    nowMs: 35 * MIN,
    attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
    ...overrides,
  };
}

describe("WeatherControls", () => {
  it("toggling the layer calls the handler", async () => {
    const onToggle = vi.fn();
    render(<WeatherControls {...props({ show: false, onToggle })} />);

    await userEvent.setup().click(screen.getByRole("checkbox", { name: /winds aloft/i }));

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("disables the toggle and says why when the live source is not MQTT", () => {
    render(
      <WeatherControls
        {...props({ availability: "unsupported_source", validTimeMs: null, attribution: null })}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /winds aloft/i })).toBeDisabled();
    expect(screen.getByText(/mqtt/i)).toBeInTheDocument();
  });

  it("says it is waiting before the first snapshot", () => {
    render(
      <WeatherControls {...props({ availability: "waiting", validTimeMs: null, attribution: null })} />,
    );

    expect(screen.getByText(/waiting for the weather service/i)).toBeInTheDocument();
  });

  it("offers the surface and every level in the snapshot", () => {
    render(<WeatherControls {...props()} />);

    expect(screen.getByRole("button", { name: "SFC" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "FL340 · 250 hPa" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(7);
  });

  it("marks the selected level", () => {
    render(<WeatherControls {...props({ level: 250 })} />);

    expect(screen.getByRole("button", { name: "FL340 · 250 hPa" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "SFC" })).toHaveAttribute("aria-pressed", "false");
  });

  it("reports the level that was picked", async () => {
    const onLevelChange = vi.fn();
    render(<WeatherControls {...props({ onLevelChange })} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "FL050 · 850 hPa" }));

    expect(onLevelChange).toHaveBeenCalledWith(850);
  });

  it("hides the level picker while the layer is off", () => {
    render(<WeatherControls {...props({ show: false })} />);

    expect(screen.queryByRole("button", { name: "SFC" })).not.toBeInTheDocument();
  });

  it("shows how old the data is", () => {
    render(<WeatherControls {...props()} />);

    expect(screen.getByText(/valid 35 min ago/)).toBeInTheDocument();
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument();
  });

  it("flags stale data", () => {
    render(<WeatherControls {...props({ stale: true, nowMs: 5 * 60 * MIN })} />);

    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });

  it("credits the data source", () => {
    render(<WeatherControls {...props()} />);

    expect(screen.getByText(/open-meteo/i)).toBeInTheDocument();
  });

  it("offers barbs and particles as independent display toggles", () => {
    render(<WeatherControls {...props({ showBarbs: true, showParticles: false })} />);

    expect(screen.getByRole("checkbox", { name: /barbs/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /particles/i })).not.toBeChecked();
  });

  it("reports a barbs toggle", async () => {
    const onToggleBarbs = vi.fn();
    render(<WeatherControls {...props({ onToggleBarbs })} />);

    await userEvent.setup().click(screen.getByRole("checkbox", { name: /barbs/i }));

    expect(onToggleBarbs).toHaveBeenCalledOnce();
  });

  it("reports a particles toggle", async () => {
    const onToggleParticles = vi.fn();
    render(<WeatherControls {...props({ onToggleParticles })} />);

    await userEvent.setup().click(screen.getByRole("checkbox", { name: /particles/i }));

    expect(onToggleParticles).toHaveBeenCalledOnce();
  });

  it("hides the display toggles while the layer is off", () => {
    render(<WeatherControls {...props({ show: false })} />);

    expect(screen.queryByRole("checkbox", { name: /barbs/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /particles/i })).not.toBeInTheDocument();
  });

  describe("the Fetch weather switch", () => {
    it("is absent without a command handler", () => {
      render(<WeatherControls {...props({ service: service() })} />);

      expect(screen.queryByRole("checkbox", { name: /fetch weather/i })).not.toBeInTheDocument();
    });

    it("follows the service's reported setting", () => {
      render(
        <WeatherControls
          {...props({ service: service({ enabled: false, state: "disabled" }), onServiceToggle: vi.fn() })}
        />,
      );

      expect(screen.getByRole("checkbox", { name: /fetch weather/i })).not.toBeChecked();
      expect(screen.getByText(/paused/i)).toBeInTheDocument();
    });

    it("sends the opposite of the current setting", async () => {
      const onServiceToggle = vi.fn();
      render(<WeatherControls {...props({ service: service(), onServiceToggle })} />);

      await userEvent.setup().click(screen.getByRole("checkbox", { name: /fetch weather/i }));

      expect(onServiceToggle).toHaveBeenCalledWith(false);
    });

    it("stays locked and says so while a request is pending", () => {
      render(
        <WeatherControls
          {...props({ service: service({ enabled: true }), pendingEnabled: false, onServiceToggle: vi.fn() })}
        />,
      );

      const toggle = screen.getByRole("checkbox", { name: /fetch weather/i });
      expect(toggle).toBeDisabled();
      expect(toggle).not.toBeChecked();
      expect(screen.getByText(/pausing/i)).toBeInTheDocument();
    });

    it("cannot command an offline service, and says it is offline", () => {
      render(
        <WeatherControls
          {...props({
            service: { ...service(), availability: "offline" },
            onServiceToggle: vi.fn(),
          })}
        />,
      );

      expect(screen.getByRole("checkbox", { name: /fetch weather/i })).toBeDisabled();
      expect(screen.getByText(/weather service offline/i)).toBeInTheDocument();
    });

    it("names the rate limit the service ran into", () => {
      render(
        <WeatherControls
          {...props({
            service: service({ state: "rate_limited", rate_limit: "daily" }),
            onServiceToggle: vi.fn(),
          })}
        />,
      );

      expect(screen.getByText(/daily limit reached/i)).toBeInTheDocument();
    });

    it("shows why a command did not take", () => {
      render(
        <WeatherControls
          {...props({
            service: service(),
            serviceError: "weather service at http://pi-roof:8789 is unreachable",
            onServiceToggle: vi.fn(),
          })}
        />,
      );

      expect(screen.getByRole("alert")).toHaveTextContent(/unreachable/);
    });

    it("is not offered when the live source is not MQTT", () => {
      render(
        <WeatherControls
          {...props({
            availability: "unsupported_source",
            validTimeMs: null,
            attribution: null,
            service: service(),
            onServiceToggle: vi.fn(),
          })}
        />,
      );

      expect(screen.queryByRole("checkbox", { name: /fetch weather/i })).not.toBeInTheDocument();
    });
  });
});

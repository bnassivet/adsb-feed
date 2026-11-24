import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReceiverSelector } from "../ReceiverSelector";
import type { ReceiverSummary } from "@/lib/types";

function rx(source_id: string, located = true): ReceiverSummary {
  return {
    source_id,
    name: null,
    first_seen_ms: 0,
    current: located
      ? {
          valid_from_ms: 0,
          valid_to_ms: null,
          position: { latitude: 46.7, longitude: -2.3, altitude_ft: null },
          origin: "config",
          recorded_at_ms: 0,
          note: null,
        }
      : null,
    period_count: located ? 1 : 0,
  };
}

describe("ReceiverSelector", () => {
  it("stays out of the way with a single receiver", () => {
    const { container } = render(
      <ReceiverSelector receivers={[rx("pi-a")]} selectedId="pi-a" onSelect={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("offers every receiver and marks the ones with no known location", () => {
    render(
      <ReceiverSelector
        receivers={[rx("pi-a"), rx("pi-quiet", false)]}
        selectedId="pi-a"
        onSelect={() => {}}
      />
    );
    const select = screen.getByRole("combobox", { name: /receiver/i });
    expect(select).toHaveValue("pi-a");
    expect(screen.getByRole("option", { name: "pi-a" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "pi-quiet (no location)" })).toBeInTheDocument();
  });

  it("reports the choice", async () => {
    const onSelect = vi.fn();
    render(
      <ReceiverSelector receivers={[rx("pi-a"), rx("pi-b")]} selectedId="pi-a" onSelect={onSelect} />
    );
    await userEvent.setup().selectOptions(screen.getByRole("combobox"), "pi-b");
    expect(onSelect).toHaveBeenCalledWith("pi-b");
  });
});

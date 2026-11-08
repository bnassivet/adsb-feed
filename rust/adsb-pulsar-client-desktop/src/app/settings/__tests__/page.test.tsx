import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMockResponses, mockInvokeResponse } from "@/test/mocks/tauri";
import SettingsPage from "../page";

// The section's own behaviour is tested on its own; here only what the page hands it.
vi.mock("@/components/TileCacheSection", () => ({
  TileCacheSection: ({ receiver }: { receiver: { lat: number; lon: number } | null }) => (
    <div data-testid="tile-cache-receiver">{JSON.stringify(receiver)}</div>
  ),
}));

const CONFIG = {
  source_id: "test",
  socket_host: "localhost",
  socket_port: 30003,
  receiver_latitude: 45.5,
  receiver_longitude: -73.6,
  receiver_altitude: null,
};

afterEach(() => clearMockResponses());

function input(label: string): HTMLInputElement {
  return screen.getByText(label).nextElementSibling as HTMLInputElement;
}

describe("SettingsPage → Map Tile Cache", () => {
  it("gets the SAVED receiver location, not one still being typed", async () => {
    // Apply prunes the cache around this point: an unsaved, half-typed
    // latitude must not delete the tiles downloaded for the real one.
    let saved: unknown = null;
    mockInvokeResponse("get_config", CONFIG);
    mockInvokeResponse("get_storage_mode", { mode: "embedded" });
    mockInvokeResponse("get_status", { is_running: false });
    mockInvokeResponse("save_config", (args: { config: unknown }) => {
      saved = args.config;
      return null;
    });
    render(<SettingsPage />);
    const shown = await screen.findByTestId("tile-cache-receiver");
    expect(JSON.parse(shown.textContent!)).toEqual({ lat: 45.5, lon: -73.6 });

    fireEvent.change(input("Latitude"), { target: { value: "4" } });
    expect(JSON.parse(screen.getByTestId("tile-cache-receiver").textContent!)).toEqual({ lat: 45.5, lon: -73.6 });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved).not.toBeNull());
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId("tile-cache-receiver").textContent!)).toEqual({ lat: 4, lon: -73.6 }),
    );
  });
});

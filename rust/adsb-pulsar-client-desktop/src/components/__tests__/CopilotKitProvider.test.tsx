import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";

const copilotKitSpy = vi.fn();

vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotKit: (props: Record<string, unknown>) => {
    copilotKitSpy(props);
    return null;
  },
}));

/** The flag is read once at module load, like Next inlines it at build time. */
async function renderWithEnv(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) vi.stubEnv("NEXT_PUBLIC_COPILOTKIT_DISABLE_INSPECTOR", "");
  else vi.stubEnv("NEXT_PUBLIC_COPILOTKIT_DISABLE_INSPECTOR", value);
  copilotKitSpy.mockClear();
  const { CopilotKitProvider } = await import("../CopilotKitProvider");
  render(<CopilotKitProvider>{null}</CopilotKitProvider>);
  return copilotKitSpy.mock.calls[0][0];
}

describe("CopilotKitProvider inspector switch", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("leaves the dev inspector on by default, without overriding the chat", async () => {
    // Unset, not true: CopilotKit gives a provider-level value priority over
    // CopilotChat's `inspectorTools` (`providerEnableInspector ?? inspectorTools`),
    // so `true` here would bring back the per-message wrench the chat hides.
    // Unset still shows the floating inspector (`enableInspector !== false`).
    const props = await renderWithEnv(undefined);
    expect(props.enableInspector).toBeUndefined();
  });

  it("turns it off with NEXT_PUBLIC_COPILOTKIT_DISABLE_INSPECTOR=true", async () => {
    // enableInspector={false} means the inspector is never mounted, so its CDN
    // feeds, Google Fonts and Loom videos are never requested.
    const props = await renderWithEnv("true");
    expect(props.enableInspector).toBe(false);
  });

  it("still points CopilotKit at the agent", async () => {
    const props = await renderWithEnv(undefined);
    expect(props.agent).toBe("adsb_agent");
    expect(String(props.runtimeUrl)).toMatch(/\/ag-ui$/);
  });
});

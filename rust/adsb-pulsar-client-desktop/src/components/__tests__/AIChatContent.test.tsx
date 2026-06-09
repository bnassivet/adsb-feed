import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MicButton } from "../MicButton";

describe("MicButton", () => {
  it("shows mic icon and idle styling when not listening", () => {
    const { container } = render(
      <MicButton isListening={false} onToggle={() => {}} />
    );
    const btn = container.querySelector("button")!;
    expect(btn).toHaveAttribute("aria-label", "Start voice input");
    expect(btn.className).toContain("bg-slate-700");
    expect(btn.className).not.toContain("bg-red-500");
    expect(btn.className).not.toContain("ring-2");
  });

  it("shows stop icon, red background, and ring when listening", () => {
    const { container } = render(
      <MicButton isListening={true} onToggle={() => {}} />
    );
    const btn = container.querySelector("button")!;
    expect(btn).toHaveAttribute("aria-label", "Stop listening");
    expect(btn.className).toContain("bg-red-500");
    expect(btn.className).toContain("ring-2");
    expect(btn.className).not.toContain("bg-slate-700");
  });

  it("calls onToggle when clicked", async () => {
    const onToggle = vi.fn();
    const { container } = render(
      <MicButton isListening={false} onToggle={onToggle} />
    );
    await userEvent.click(container.querySelector("button")!);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

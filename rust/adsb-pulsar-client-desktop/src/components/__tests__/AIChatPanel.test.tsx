import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AIChatPanel } from "../AIChatPanel";

const baseProps = {
  isOpen: true,
  onToggle: () => {},
  width: 360,
  onWidthChange: () => {},
  dockedExpanded: true,
  onDockedExpandedChange: () => {},
  floating: false,
  onFloatingChange: () => {},
  floatX: 0,
  floatY: 0,
  floatW: 400,
  floatH: 520,
  onFloatPosChange: () => {},
  onFloatSizeChange: () => {},
};

describe("AIChatPanel — New Conversation button", () => {
  it("renders a New Conversation button leftmost in docked header when onNewConversation provided", async () => {
    const onNewConversation = vi.fn();
    render(
      <AIChatPanel {...baseProps} onNewConversation={onNewConversation}>
        <div>body</div>
      </AIChatPanel>,
    );

    const btn = screen.getByTitle("New Conversation");
    expect(btn).toBeInTheDocument();
    await userEvent.click(btn);
    expect(onNewConversation).toHaveBeenCalledOnce();
  });

  it("places the New Conversation button before the dock and collapse actions in docked mode", () => {
    const onNewConversation = vi.fn();
    render(
      <AIChatPanel {...baseProps} onNewConversation={onNewConversation}>
        <div>body</div>
      </AIChatPanel>,
    );

    const newBtn = screen.getByTitle("New Conversation");
    const collapseBtn = screen.getByTitle("Collapse panel");
    // Compare DOM order: New Conversation must precede the collapse button
    expect(newBtn.compareDocumentPosition(collapseBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders a New Conversation button in floating header too", async () => {
    const onNewConversation = vi.fn();
    render(
      <AIChatPanel {...baseProps} floating={true} onNewConversation={onNewConversation}>
        <div>body</div>
      </AIChatPanel>,
    );

    const btn = screen.getByTitle("New Conversation");
    expect(btn).toBeInTheDocument();
    await userEvent.click(btn);
    expect(onNewConversation).toHaveBeenCalledOnce();
  });

  it("places the New Conversation button before the close action in floating mode", () => {
    const onNewConversation = vi.fn();
    render(
      <AIChatPanel {...baseProps} floating={true} onNewConversation={onNewConversation}>
        <div>body</div>
      </AIChatPanel>,
    );

    const newBtn = screen.getByTitle("New Conversation");
    const closeBtn = screen.getByTitle("Close");
    expect(newBtn.compareDocumentPosition(closeBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("omits the button when onNewConversation is not provided", () => {
    render(
      <AIChatPanel {...baseProps}>
        <div>body</div>
      </AIChatPanel>,
    );
    expect(screen.queryByTitle("New Conversation")).toBeNull();
  });
});

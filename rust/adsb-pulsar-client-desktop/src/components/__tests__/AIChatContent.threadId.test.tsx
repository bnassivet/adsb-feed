import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

const copilotChatSpy = vi.fn();

vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotChat: (props: Record<string, unknown>) => {
    copilotChatSpy(props);
    return null;
  },
}));

vi.mock("@copilotkit/react-core/v2/styles.css", () => ({}));

vi.mock("@/hooks/useVoiceInput", () => ({
  useVoiceInput: () => ({
    backend: "voxtral",
    setBackend: () => {},
    isListening: false,
    toggleListening: () => {},
    backends: {},
    error: null,
    finalTranscript: "",
    clearFinalTranscript: () => {},
  }),
}));

import { AIChatContent } from "../AIChatContent";

describe("AIChatContent threadId forwarding", () => {
  it("forwards the threadId prop to CopilotChat", () => {
    copilotChatSpy.mockClear();
    render(<AIChatContent threadId="thread-xyz" />);

    expect(copilotChatSpy).toHaveBeenCalled();
    const props = copilotChatSpy.mock.calls[0][0];
    expect(props.threadId).toBe("thread-xyz");
  });

  it("passes threadId=undefined when prop omitted", () => {
    copilotChatSpy.mockClear();
    render(<AIChatContent />);

    expect(copilotChatSpy).toHaveBeenCalled();
    const props = copilotChatSpy.mock.calls[0][0];
    expect(props.threadId).toBeUndefined();
  });
});

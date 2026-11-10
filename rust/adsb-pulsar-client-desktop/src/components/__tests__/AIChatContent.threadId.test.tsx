import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

const copilotChatSpy = vi.fn();
const useAgentSpy = vi.fn();

vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotChat: (props: Record<string, unknown>) => {
    copilotChatSpy(props);
    return null;
  },
  useAgent: (props: Record<string, unknown>) => {
    useAgentSpy(props);
    return { agent: { addMessage: vi.fn(), runAgent: vi.fn() } };
  },
  useCopilotKit: () => ({ copilotkit: { runAgent: vi.fn() } }),
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

  /**
   * CopilotKit >= 1.85: CopilotChat resolves the SHARED agent
   * (`useAgent({ agentId })`) and writes `agent.threadId = threadId` onto it.
   * The voice path must take that same instance, or its messages land in a
   * different conversation. Passing `threadId` without `runtimeAgentId` now
   * throws ("`threadId` requires `runtimeAgentId`").
   */
  it("binds voice to the shared agent CopilotChat uses, without a threadId", () => {
    useAgentSpy.mockClear();
    render(<AIChatContent threadId="thread-xyz" />);

    expect(useAgentSpy).toHaveBeenCalled();
    for (const [props] of useAgentSpy.mock.calls) {
      expect(props).toEqual({ agentId: "adsb_agent" });
    }
  });
});

"use client";
/**
 * Chat UI powered by CopilotKit's CopilotChat component.
 * Renders inside AIChatPanel (docked or floating).
 * Includes voice input controls (mic toggle, backend selector).
 */
import { useEffect, useRef } from "react";
import { CopilotChat, useAgent, useCopilotKit } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { useVoiceInput, type VoiceBackendId } from "@/hooks/useVoiceInput";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { MicButton } from "./MicButton";
import { AGENT_ID } from "./CopilotKitProvider";

function BackendSelector({
  backend,
  onChange,
  backends,
}: {
  backend: VoiceBackendId;
  onChange: (b: VoiceBackendId) => void;
  backends: Record<string, { status: string; description: string }>;
}) {
  return (
    <select
      value={backend}
      onChange={(e) => onChange(e.target.value as VoiceBackendId)}
      className="text-[10px] bg-slate-700 text-slate-300 rounded px-1 py-0.5 border border-slate-600"
      title="Voice backend"
    >
      <option value="voxtral">
        Voxtral STT{backends.voxtral ? ` (${backends.voxtral.status})` : ""}
      </option>
      <option value="lfm2-audio">
        LFM2.5 Audio{backends["lfm2-audio"] ? ` (${backends["lfm2-audio"].status})` : ""}
      </option>
    </select>
  );
}

export function AIChatContent({ threadId }: { threadId?: string } = {}) {
  const {
    backend,
    setBackend,
    isListening,
    toggleListening,
    backends,
    error,
    finalTranscript,
    clearFinalTranscript,
  } = useVoiceInput(threadId);

  // Voice transcript handling mode: false = manual banner (Edit/Send/Dismiss),
  // true = auto-fill the input and submit the transcript with no clicks.
  const [autoSend, setAutoSend] = useLocalStorage("adsb-voice-autosend", false);

  // Same agent instance CopilotChat renders (keyed by threadId) — lets us add a
  // user message and run it programmatically, exactly like the chat input does.
  const { agent } = useAgent({ agentId: AGENT_ID, threadId });
  // Core runner injects the registered frontend tools into the run; calling
  // agent.runAgent() directly omits them (agent warns "no frontend tools supplied").
  const { copilotkit } = useCopilotKit();

  // Ref to programmatically set the CopilotChat input via DOM (manual "Edit")
  const chatContainerRef = useRef<HTMLDivElement>(null);

  const injectTranscriptToInput = () => {
    if (!finalTranscript || !chatContainerRef.current) return;
    // Find the CopilotChat textarea/input and set its value + dispatch input event
    const input = chatContainerRef.current.querySelector<HTMLTextAreaElement | HTMLInputElement>(
      "textarea, input[type='text']"
    );
    if (input) {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
      )?.set ?? Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value"
      )?.set;
      nativeSetter?.call(input, finalTranscript);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    }
    clearFinalTranscript();
  };

  // Remembers the transcript already sent, so auto-send fires once per recording
  // even though finalTranscript intentionally lingers (green banner stays until
  // the next recording clears it).
  const sentTranscriptRef = useRef<string | null>(null);

  // Send the transcript to the assistant via the agent API (adds a user message
  // and runs the agent) — robust regardless of the chat input's DOM/disabled state.
  // Does NOT clear finalTranscript: the green banner stays until the next recording.
  const sendTranscript = () => {
    if (!finalTranscript || !agent) return;
    const text = finalTranscript;
    sentTranscriptRef.current = text;
    agent.addMessage({
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `voice-${Date.now()}`,
      role: "user",
      content: text,
    });
    void copilotkit.runAgent({ agent });
  };

  // Auto mode: send each new final transcript once. The dedupe ref prevents
  // re-sending the same text on unrelated re-renders (finalTranscript lingers).
  useEffect(() => {
    if (!finalTranscript) {
      sentTranscriptRef.current = null;
      return;
    }
    if (autoSend && finalTranscript !== sentTranscriptRef.current) {
      sendTranscript();
    }
    // sendTranscript reads the current finalTranscript via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend, finalTranscript]);

  return (
    <div ref={chatContainerRef} className="flex-1 overflow-hidden flex flex-col [&_.copilotkit-chat-messages]:bg-slate-900 [&_.copilotkit-chat-input]:bg-slate-800">
      <CopilotChat
        threadId={threadId}
        labels={{
          modalHeaderTitle: "ADS-B Assistant",
          welcomeMessageText: "Ask me about aircraft, flights, or database stats.",
          chatInputPlaceholder: "Ask about aircraft tracking...",
        }}
        className="flex-1 min-h-0"
      />
      {/* Voice transcript banner — green text stays visible until the next recording.
          Manual mode shows Edit/Send; auto mode already sent it, so only Dismiss. */}
      {finalTranscript && (
        <div className="flex items-center gap-2 px-3 py-2 bg-emerald-900/40 border-t border-emerald-700/50">
          <span className="text-xs text-emerald-300 flex-1 truncate" title={finalTranscript}>
            &ldquo;{finalTranscript}&rdquo;
          </span>
          {!autoSend && (
            <>
              <button
                onClick={injectTranscriptToInput}
                className="text-[10px] px-2 py-0.5 rounded bg-slate-700 text-slate-300 hover:bg-slate-600"
                title="Edit in input field"
              >
                Edit
              </button>
              <button
                onClick={sendTranscript}
                className="text-[10px] px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-500"
                title="Send to assistant"
              >
                Send
              </button>
            </>
          )}
          {autoSend && (
            <span className="text-[10px] text-emerald-400/70 shrink-0">sent</span>
          )}
          <button
            onClick={clearFinalTranscript}
            className="text-[10px] text-slate-400 hover:text-slate-200"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {/* Voice controls bar */}
      <div className={`flex items-center gap-2 px-3 py-1.5 border-t transition-colors duration-200 ${
        isListening
          ? "bg-red-950/60 border-red-800/50"
          : "bg-slate-800 border-slate-700"
      }`}>
        <MicButton isListening={isListening} onToggle={toggleListening} />
        <BackendSelector
          backend={backend}
          onChange={setBackend}
          backends={backends}
        />
        {isListening && (
          <span className="flex items-center gap-1.5 text-xs text-red-300 truncate flex-1">
            <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
            Recording
          </span>
        )}
        {!isListening && !error && (
          <span className="text-xs text-slate-500 truncate flex-1">
            Voice off
          </span>
        )}
        {error && (
          <span className="text-xs text-red-400 truncate flex-1" title={error}>
            {error}
          </span>
        )}
        <label
          className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer select-none ml-auto shrink-0"
          title="Automatically send voice transcript to the assistant"
        >
          <input
            type="checkbox"
            checked={autoSend}
            onChange={(e) => setAutoSend(e.target.checked)}
            className="accent-emerald-500"
          />
          Auto-send
        </label>
      </div>
    </div>
  );
}

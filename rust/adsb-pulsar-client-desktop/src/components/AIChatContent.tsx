"use client";
/**
 * Chat UI powered by CopilotKit's CopilotChat component.
 * Renders inside AIChatPanel (docked or floating).
 * Includes voice input controls (mic toggle, backend selector).
 */
import { useRef } from "react";
import { CopilotChat } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { useVoiceInput, type VoiceBackendId } from "@/hooks/useVoiceInput";

function MicButton({
  isListening,
  onToggle,
}: {
  isListening: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`
        flex items-center justify-center w-8 h-8 rounded-full transition-all
        ${isListening
          ? "bg-red-500/80 text-white shadow-lg shadow-red-500/30 animate-pulse"
          : "bg-slate-700 text-slate-300 hover:bg-slate-600"
        }
      `}
      title={isListening ? "Stop listening" : "Start voice input"}
      aria-label={isListening ? "Stop listening" : "Start voice input"}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        {isListening ? (
          // Stop icon (square)
          <rect x="6" y="6" width="12" height="12" rx="2" />
        ) : (
          // Mic icon
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V23h2v-2.06A9 9 0 0 0 21 12v-2h-2z" />
        )}
      </svg>
    </button>
  );
}

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

export function AIChatContent() {
  const {
    backend,
    setBackend,
    isListening,
    toggleListening,
    backends,
    error,
    finalTranscript,
    clearFinalTranscript,
  } = useVoiceInput();

  // Ref to programmatically set the CopilotChat input via DOM
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

  const sendTranscript = () => {
    if (!finalTranscript || !chatContainerRef.current) return;
    injectTranscriptToInput();
    // Submit after a tick so React processes the input change
    requestAnimationFrame(() => {
      const form = chatContainerRef.current?.querySelector("form");
      if (form) {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    });
  };

  return (
    <div ref={chatContainerRef} className="flex-1 overflow-hidden flex flex-col [&_.copilotkit-chat-messages]:bg-slate-900 [&_.copilotkit-chat-input]:bg-slate-800">
      <CopilotChat
        labels={{
          modalHeaderTitle: "ADS-B Assistant",
          welcomeMessageText: "Ask me about aircraft, flights, or database stats.",
          chatInputPlaceholder: "Ask about aircraft tracking...",
        }}
        className="h-full"
      />
      {/* Voice transcript banner */}
      {finalTranscript && (
        <div className="flex items-center gap-2 px-3 py-2 bg-emerald-900/40 border-t border-emerald-700/50">
          <span className="text-xs text-emerald-300 flex-1 truncate" title={finalTranscript}>
            &ldquo;{finalTranscript}&rdquo;
          </span>
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
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border-t border-slate-700">
        <MicButton isListening={isListening} onToggle={toggleListening} />
        <BackendSelector
          backend={backend}
          onChange={setBackend}
          backends={backends}
        />
        {isListening && (
          <span className="text-xs text-slate-400 truncate flex-1">
            Listening...
          </span>
        )}
        {error && (
          <span className="text-xs text-red-400 truncate flex-1" title={error}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

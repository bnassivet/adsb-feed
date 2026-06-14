"use client";
/**
 * Hook for voice input — manages mic toggle, backend selection,
 * and transcript streaming from the Python agent's voice service.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalStorage } from "./useLocalStorage";

export type VoiceBackendId = "voxtral" | "lfm2-audio";

export interface VoiceBackendInfo {
  name: string;
  description: string;
  status: string;
  supports_end_to_end: boolean;
  model_size: string | null;
}

export interface UseVoiceInputReturn {
  /** Currently selected backend. */
  backend: VoiceBackendId;
  /** Switch backend. */
  setBackend: (b: VoiceBackendId) => void;
  /** Whether the mic is actively capturing. */
  isListening: boolean;
  /** Start microphone capture. */
  startListening: () => Promise<void>;
  /** Stop microphone capture. */
  stopListening: () => Promise<void>;
  /** Toggle listening state. */
  toggleListening: () => Promise<void>;
  /** Current interim transcript text (updated as the user speaks). */
  transcript: string;
  /** Available backends with their status. */
  backends: Record<string, VoiceBackendInfo>;
  /** Error message if something went wrong. */
  error: string | null;
  /** Final transcript returned when voice capture stops (batch STT). */
  finalTranscript: string | null;
  /** Clear the final transcript after it has been consumed. */
  clearFinalTranscript: () => void;
}

const AGENT_BASE = "http://localhost:8000";

export function useVoiceInput(threadId?: string): UseVoiceInputReturn {
  const [backend, setBackend] = useLocalStorage<VoiceBackendId>(
    "adsb-voice-backend",
    "voxtral",
  );
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [backends, setBackends] = useState<Record<string, VoiceBackendInfo>>({});
  const [error, setError] = useState<string | null>(null);
  const [finalTranscript, setFinalTranscript] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Fetch available backends on mount
  useEffect(() => {
    fetch(`${AGENT_BASE}/voice/backends`)
      .then((res) => res.json())
      .then((data) => {
        if (data.backends) setBackends(data.backends);
      })
      .catch(() => {
        // Agent not running — backends unavailable
      });
  }, []);

  const startListening = useCallback(async () => {
    setError(null);
    // Drop the previous recording's final transcript immediately, before any
    // network call, so the banner doesn't show stale text during the new
    // recording — even if /voice/start fails.
    setFinalTranscript(null);
    setTranscript("");
    try {
      const res = await fetch(`${AGENT_BASE}/voice/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend, session_id: threadId ?? null }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        return;
      }
      setIsListening(true);

      // Open SSE stream for transcript
      const es = new EventSource(`${AGENT_BASE}/voice/transcript`);
      eventSourceRef.current = es;
      es.onmessage = (event) => {
        try {
          const chunk = JSON.parse(event.data);
          if (chunk.is_final) {
            setTranscript((prev) => (prev ? prev + " " + chunk.text : chunk.text));
          } else {
            // Show interim transcript
            setTranscript((prev) => {
              const parts = prev.split(" ");
              // Replace last incomplete word with interim
              if (parts.length > 0 && !prev.endsWith(" ")) {
                parts[parts.length - 1] = chunk.text;
                return parts.join(" ");
              }
              return prev + chunk.text;
            });
          }
        } catch {
          // Ignore parse errors
        }
      };
      es.onerror = () => {
        // SSE connection lost — show error but keep listening state so the
        // user can still click stop to end the session cleanly.
        es.close();
        eventSourceRef.current = null;
        setError("Voice stream disconnected");
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start voice");
    }
  }, [backend, threadId]);

  const stopListening = useCallback(async () => {
    // Close transcript stream
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    // Clear the banner the instant the user clicks stop. /voice/stop can
    // take many seconds (voxtral's stdout drain), and during that wait the
    // previous recording's transcript must NOT remain on screen.
    setFinalTranscript(null);
    try {
      const res = await fetch(`${AGENT_BASE}/voice/stop`, { method: "POST" });
      const data = await res.json();
      if (data.transcript) {
        setFinalTranscript(data.transcript);
      }
    } catch {
      // Agent unavailable — banner stays cleared from the synchronous reset above.
    }
    setIsListening(false);
  }, []);

  const toggleListening = useCallback(async () => {
    if (isListening) {
      await stopListening();
    } else {
      await startListening();
    }
  }, [isListening, startListening, stopListening]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Auto-stop voice + clear stale transcript when the chat thread changes.
  // The previous thread's voice session must not bleed into the new one.
  // `isListening` is read directly (in the effect deps) instead of via a render-synced ref; the
  // prevThreadIdRef guard ensures the body still only acts when threadId actually changes, so the
  // extra runs when isListening toggles within the same thread are no-ops.
  const prevThreadIdRef = useRef<string | undefined>(threadId);
  useEffect(() => {
    if (prevThreadIdRef.current !== threadId) {
      prevThreadIdRef.current = threadId;
      if (isListening) {
        // Stop first; stopListening reads /voice/stop which may set finalTranscript
        // — clear AFTER it resolves so the stale transcript doesn't leak into the new thread.
        void stopListening().then(() => setFinalTranscript(null));
      } else {
        setFinalTranscript(null);
      }
    }
  }, [threadId, isListening, stopListening]);

  const clearFinalTranscript = useCallback(() => {
    setFinalTranscript(null);
  }, []);

  return {
    backend,
    setBackend,
    isListening,
    startListening,
    stopListening,
    toggleListening,
    transcript,
    backends,
    error,
    finalTranscript,
    clearFinalTranscript,
  };
}

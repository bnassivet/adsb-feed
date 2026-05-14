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

export function useVoiceInput(): UseVoiceInputReturn {
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
    try {
      const res = await fetch(`${AGENT_BASE}/voice/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        return;
      }
      setIsListening(true);
      setTranscript("");

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
        // SSE connection lost — stop listening
        es.close();
        eventSourceRef.current = null;
        setIsListening(false);
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start voice");
    }
  }, [backend]);

  const stopListening = useCallback(async () => {
    // Close transcript stream
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    try {
      const res = await fetch(`${AGENT_BASE}/voice/stop`, { method: "POST" });
      const data = await res.json();
      if (data.transcript) {
        setFinalTranscript(data.transcript);
      }
    } catch {
      // Agent may be unavailable
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

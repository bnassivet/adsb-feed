"use client";
/**
 * Mint a fresh AG-UI thread id on each chat-panel open.
 *
 * Returns `undefined` while the panel is closed; on every false→true
 * transition of `isOpen`, a new UUID v7 is generated and held stable until
 * the panel closes again. This makes one chat-panel lifetime correspond to
 * one AG-UI thread — and, on the agent side, one MLflow session.
 */
import { useEffect, useState } from "react";
import { v7 as uuidv7 } from "uuid";

export function useChatThreadId(isOpen: boolean): string | undefined {
  const [threadId, setThreadId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (isOpen) {
      setThreadId(uuidv7());
    } else {
      setThreadId(undefined);
    }
  }, [isOpen]);

  return threadId;
}

"use client";
/**
 * Mint a fresh AG-UI thread id per chat-panel conversation.
 *
 * - Returns `threadId === undefined` while the panel is closed.
 * - On every false→true transition of `isOpen`, mints a new UUID v7.
 * - `resetThread()` mints a new UUID v7 in place (no close/open flicker)
 *   so the user can start a fresh conversation while keeping panel state.
 *
 * One thread id corresponds to one AG-UI thread and, on the agent side,
 * one MLflow session.
 */
import { useCallback, useEffect, useState } from "react";
import { v7 as uuidv7 } from "uuid";

export interface UseChatThreadIdReturn {
  threadId: string | undefined;
  resetThread: () => void;
}

export function useChatThreadId(isOpen: boolean): UseChatThreadIdReturn {
  const [threadId, setThreadId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (isOpen) {
      setThreadId(uuidv7());
    } else {
      setThreadId(undefined);
    }
  }, [isOpen]);

  const resetThread = useCallback(() => {
    // Only mint a new id if the panel is open — otherwise we'd resurrect
    // a thread for a closed panel and the next open would mint another.
    setThreadId((prev) => (prev === undefined ? prev : uuidv7()));
  }, []);

  return { threadId, resetThread };
}

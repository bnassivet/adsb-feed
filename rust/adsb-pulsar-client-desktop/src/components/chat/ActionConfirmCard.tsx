"use client";
/**
 * Chat card rendering confirmation for action tool calls (startFeed, stopFeed).
 */
import { ChatCard } from "./ChatCard";

interface Props {
  action: "start" | "stop";
  status: "in_progress" | "executing" | "complete";
  result?: string;
}

export function ActionConfirmCard({ action, status, result }: Props) {
  const title = action === "start" ? "Start Feed" : "Stop Feed";
  const icon = action === "start" ? "▶️" : "⏹️";

  return (
    <ChatCard title={title} icon={icon} status={status}>
      {status === "complete" && result && (
        <div className="flex items-center gap-2 text-xs">
          <span className="w-2 h-2 rounded-full bg-green-400" />
          <span className="text-green-300">{result}</span>
        </div>
      )}
    </ChatCard>
  );
}

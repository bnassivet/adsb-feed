"use client";
/**
 * One compact line per tool call that has no card of its own: a running/done
 * mark, the tool's name and its parameters. Registered as CopilotKit's
 * wildcard ("*") tool renderer in useCopilotTools.
 *
 * Deliberately no result: the answer text carries the data, and the five tools
 * with a card render it there instead.
 */

const MAX_VALUE_CHARS = 40;
const MAX_PARAMS = 4;

interface Props {
  name: string;
  /** CopilotKit's render status: "inProgress" | "executing" | "complete". */
  status: string;
  /** Partial while the arguments are still streaming in. */
  parameters: Record<string, unknown> | undefined;
}

function formatValue(key: string, value: unknown): string {
  if (typeof value === "number" && key.endsWith("Ms") && Number.isFinite(value)) {
    return new Date(value).toLocaleString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…` : text;
}

export function ToolCallChip({ name, status, parameters }: Props) {
  const done = status === "complete";
  const entries = Object.entries(parameters ?? {}).filter(([, v]) => v !== undefined);
  const shown = entries.slice(0, MAX_PARAMS);
  const hidden = entries.length - shown.length;

  return (
    <div
      className="my-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1 text-xs"
      title={entries.length ? JSON.stringify(parameters, null, 2) : undefined}
    >
      {done ? (
        <span aria-label="done" className="text-emerald-400">
          ✓
        </span>
      ) : (
        <span aria-label="running" className="animate-pulse text-slate-400">
          ⋯
        </span>
      )}
      <span className="font-mono font-medium text-slate-200">{name}</span>
      {shown.map(([key, value]) => (
        <span key={key} className="font-mono text-slate-400">
          {`${key}=${formatValue(key, value)}`}
        </span>
      ))}
      {hidden > 0 && <span className="text-slate-500">+{hidden} more</span>}
    </div>
  );
}

"use client";
/**
 * Shared wrapper for all chat card components.
 * Provides consistent styling, loading state, and error handling.
 */
import type { ReactNode } from "react";

interface ChatCardProps {
  title: string;
  icon?: string;
  status: "in_progress" | "executing" | "complete";
  children: ReactNode;
}

export function ChatCard({ title, icon, status, children }: ChatCardProps) {
  const isLoading = status === "in_progress" || status === "executing";

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/80 text-sm my-1 overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-700 bg-slate-800">
        {icon && <span className="text-xs">{icon}</span>}
        <span className="font-medium text-slate-200 text-xs">{title}</span>
        {isLoading && (
          <span className="ml-auto text-xs text-slate-400 animate-pulse">Loading...</span>
        )}
      </div>
      <div className="p-3">
        {isLoading ? (
          <div className="space-y-2">
            <div className="h-3 bg-slate-700 rounded animate-pulse w-3/4" />
            <div className="h-3 bg-slate-700 rounded animate-pulse w-1/2" />
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

"use client";

export function MicButton({
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
        flex items-center justify-center w-8 h-8 rounded-full transition-all duration-200
        ${isListening
          ? "bg-red-500 text-white ring-2 ring-red-400/60 shadow-lg shadow-red-500/40"
          : "bg-slate-700 text-slate-300 hover:bg-slate-600"
        }
      `}
      title={isListening ? "Stop listening" : "Start voice input"}
      aria-label={isListening ? "Stop listening" : "Start voice input"}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        {isListening ? (
          <rect x="6" y="6" width="12" height="12" rx="2" />
        ) : (
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V23h2v-2.06A9 9 0 0 0 21 12v-2h-2z" />
        )}
      </svg>
    </button>
  );
}

"use client";

interface Props {
  theme: "light" | "dark";
  onToggle: () => void;
}

export function MapTileToggle({ theme, onToggle }: Props) {
  return (
    <button
      onClick={onToggle}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} map`}
      className="absolute top-20 right-2.5 z-[1000] w-8 h-8 bg-white rounded shadow-md border border-gray-300 flex items-center justify-center hover:bg-gray-100 transition"
    >
      {theme === "dark" ? (
        // Sun icon — currently dark, click to go light
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        // Moon icon — currently light, click to go dark
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="2" strokeLinecap="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}

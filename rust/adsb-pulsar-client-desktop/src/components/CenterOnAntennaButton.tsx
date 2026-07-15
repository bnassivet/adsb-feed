"use client";

interface Props {
  onClick: () => void;
  disabled?: boolean;
}

export function CenterOnAntennaButton({ onClick, disabled = false }: Props) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "No receiver location set" : "Center map on antenna"}
      aria-label="Center map on antenna"
      className="absolute top-11 right-2.5 z-[1000] w-8 h-8 bg-white rounded shadow-md border border-gray-300 flex items-center justify-center hover:bg-gray-100 transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white"
    >
      {/* Antenna / broadcast icon */}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="12" x2="12" y2="21" />
        <circle cx="12" cy="9" r="1.5" fill="#333" stroke="none" />
        <path d="M8.5 12.5a5 5 0 0 1 0-7" />
        <path d="M15.5 5.5a5 5 0 0 1 0 7" />
        <path d="M6 15a9 9 0 0 1 0-12" />
        <path d="M18 3a9 9 0 0 1 0 12" />
      </svg>
    </button>
  );
}

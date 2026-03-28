/** Format a last_seen timestamp as a human-readable "time ago" string. */
export function timeAgo(lastSeen: number): string {
  const seconds = Math.floor((Date.now() - lastSeen) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m ago`;
}

/**
 * Format a timestamp delta as a long-form relative string using months, days, hours.
 * Cascades from months → days → hours → minutes → seconds, showing up to two significant units.
 */
export function timeAgoLong(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  const months = Math.floor(totalDays / 30);

  if (months > 0) {
    const remainDays = totalDays - months * 30;
    return remainDays > 0 ? `${months}mo ${remainDays}d ago` : `${months}mo ago`;
  }
  if (totalDays > 0) {
    const remainHours = totalHours - totalDays * 24;
    return remainHours > 0 ? `${totalDays}d ${remainHours}h ago` : `${totalDays}d ago`;
  }
  if (totalHours > 0) {
    const remainMin = totalMinutes - totalHours * 60;
    return `${totalHours}h ${remainMin}m ago`;
  }
  if (totalMinutes > 0) return `${totalMinutes}m ago`;
  return `${totalSeconds}s ago`;
}

/**
 * Format an epoch ms as a compact local datetime string for event display.
 * Example: "2026-02-23 15:30"
 */
export function formatEventTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Format a byte count as a human-readable string (B, KB, MB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

/**
 * Format epoch ms as a human-readable datetime string in the requested timezone.
 *
 * tzMode:
 *   "local"  — machine's local timezone
 *   "utc"    — UTC
 *   "source" — IANA name from sourceTzName; if absent or "Local", falls back to local
 *
 * When an explicit timezone is provided, uses en-GB locale (24-hour clock, unambiguous).
 * When falling back to local time, uses the platform default locale.
 */
export function formatWithTz(
  ms: number,
  tzMode: "local" | "utc" | "source",
  sourceTzName?: string,
): string {
  let timeZone: string | undefined;
  if (tzMode === "utc") {
    timeZone = "UTC";
  } else if (tzMode === "source" && sourceTzName && sourceTzName !== "Local") {
    timeZone = sourceTzName;
  }
  if (timeZone) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  }
  return new Date(ms).toLocaleString();
}

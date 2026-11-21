/** Small shared formatting / DOM helpers for the webview UI. */

/** Join class names, dropping falsy entries. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}

/** Last path segment, tolerant of both separators. */
export function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** Truncate the end of a string, appending an ellipsis. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(1, max - 1)) + "…";
}

/** Truncate the middle of a string (useful for long file paths / URLs). */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return text.slice(0, half) + "…" + text.slice(text.length - half);
}

/** Compact relative time, e.g. "just now", "5m ago", "2h ago", "3d ago". */
export function relativeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const diff = Date.now() - timestamp;
  if (diff < 45_000) return "just now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** Compact token count, e.g. 1234 -> "1.2k". */
export function formatTokens(count: number | undefined): string {
  if (count == null || !Number.isFinite(count)) return "0";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(Math.round(count));
}

/** Compact USD cost, e.g. 0.0042 -> "$0.0042". */
export function formatCost(cost: number | undefined): string {
  if (cost == null || !Number.isFinite(cost)) return "";
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** Best-effort clipboard write; resolves false when unavailable/denied. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Clock time for log entries, e.g. "14:03:22". */
export function clockTime(timestamp: number): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

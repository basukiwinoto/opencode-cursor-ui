import type { LogEntry } from "../../shared/protocol";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Values that must never appear in logs. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9+/=_-]{16,}/g,
  /"apiKey"\s*:\s*"[^"]+"/g,
  /"password"\s*:\s*"[^"]+"/g,
  /"authorization"\s*:\s*"[^"]+"/gi,
];

export function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/^(apiKey|api_key|password|authorization|token|secret)$/i.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redactValue(v, depth + 1);
    }
  }
  return out;
}

export interface Log {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/**
 * Logger that writes to an output channel (injected sink) and keeps a redacted
 * ring buffer for the Runtime Control Center.
 */
export class RingLogger implements Log {
  private readonly entries: LogEntry[] = [];
  private seq = 0;
  private readonly listeners = new Set<(entries: LogEntry[]) => void>();

  constructor(
    private readonly sink: { appendLine(value: string): void },
    private maxEntries = 500,
    private level: LogLevel = "info",
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const entry: LogEntry = {
      seq: ++this.seq,
      level,
      time: Date.now(),
      message: redactString(message),
      data: data === undefined ? undefined : JSON.stringify(redactValue(data))?.slice(0, 2000),
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    const line = `[OpenCode Cursor UI] ${entry.message}${entry.data ? ` ${entry.data}` : ""}`;
    if (level === "error") this.sink.appendLine(line);
    for (const listener of this.listeners) {
      try {
        listener([entry]);
      } catch {
        // listener errors must never break logging
      }
    }
  }

  debug(message: string, data?: unknown): void {
    this.log("debug", message, data);
  }
  info(message: string, data?: unknown): void {
    this.log("info", message, data);
  }
  warn(message: string, data?: unknown): void {
    this.log("warn", message, data);
  }
  error(message: string, data?: unknown): void {
    this.log("error", message, data);
  }

  snapshot(): LogEntry[] {
    return [...this.entries];
  }

  onEntry(listener: (entries: LogEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Records a credential so it is redacted even when embedded in longer strings. */
  registerSecret(secret: string): void {
    if (!secret) return;
    SECRET_PATTERNS.push(new RegExp(escapeRegExp(secret), "g"));
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

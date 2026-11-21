/**
 * Periodic health monitoring of an OpenCode server via `GET /api/info`.
 *
 * Verified contract (OpenCode v2.2.6): `/api/info` requires HTTP Basic auth
 * (`Authorization: Basic base64("opencode:" + password)`) and responds 200
 * with JSON `{version, pid, hostname, urls, paths, capabilities}`; 401 or a
 * connection error means unhealthy.
 *
 * All timing and I/O are injectable so tests can use fake timers and a mock
 * fetch — nothing here touches the network or real timers in tests.
 */

import type { Log } from "../core/logger";
import { errorMessage } from "./exec";

/** Injectable clock/timer surface (defaults to Node globals). */
export interface Timers {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

/**
 * Builds a Timers bundle that resolves the *global* timer functions at call
 * time — so vitest fake timers (which replace the globals) are honored even
 * when the bundle was created before `vi.useFakeTimers()`.
 */
export function defaultTimers(): Timers {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

export type HealthProbeResult =
  | { healthy: true; version?: string; latencyMs: number }
  | { healthy: false; reason: string; latencyMs?: number };

export interface ProbeHealthOptions {
  fetchFn?: typeof fetch;
  /** Abort/timeout for a single probe. Default 5000ms. */
  timeoutMs?: number;
  headers?: Record<string, string> | Promise<Record<string, string>>;
  timers?: Timers;
}

/** Joins a server base URL with the /api/info path (tolerates trailing slashes). */
export function infoEndpoint(serverUrl: string): string {
  const base = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
  return `${base}/api/info`;
}

/**
 * One health probe: GET <url>/api/info with optional headers and an
 * AbortController timeout. Never throws — failures come back as
 * `{healthy: false, reason}`.
 */
export async function probeHealth(serverUrl: string, options: ProbeHealthOptions = {}): Promise<HealthProbeResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const timers = options.timers ?? defaultTimers();
  const headers = { ...(await options.headers), accept: "application/json" };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = timers.setTimeout(() => {
    controller.abort(new Error(`Health check timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    const response = await fetchFn(infoEndpoint(serverUrl), { signal: controller.signal, headers });
    if (!response.ok) {
      return {
        healthy: false,
        reason: `HTTP ${response.status}${response.statusText ? ` (${response.statusText})` : ""} from /api/info`,
        latencyMs: Date.now() - startedAt,
      };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      return {
        healthy: false,
        reason: `Invalid JSON from /api/info: ${errorMessage(error)}`,
        latencyMs: Date.now() - startedAt,
      };
    }
    const version =
      typeof payload === "object" && payload !== null && typeof (payload as Record<string, unknown>)["version"] === "string"
        ? ((payload as Record<string, unknown>)["version"] as string)
        : undefined;
    return { healthy: true, version, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      healthy: false,
      reason: describeProbeFailure(error),
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    timers.clearTimeout(timer);
  }
}

function describeProbeFailure(error: unknown): string {
  const message = errorMessage(error);
  if (message.includes("abort")) return "Request timed out";
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ECONNREFUSED") return "Connection refused (server not listening)";
  return `Connection failed: ${message}`;
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

export type HealthListener = (result: HealthProbeResult) => void;

export interface HealthMonitorOptions {
  /** Current server URL; returning undefined pauses probing. */
  serverUrl: () => string | undefined;
  /** Auth headers provider (Basic auth for managed/external servers). */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  fetchFn?: typeof fetch;
  /** Probe interval. Default 10_000ms. */
  intervalMs?: number;
  /** Per-probe timeout. Default 5_000ms. */
  timeoutMs?: number;
  timers?: Timers;
  logger?: Log;
}

/**
 * Emits health transitions for an OpenCode server. The extension layer wires
 * `onHealthChange` to the runtime manager so an unhealthy managed server
 * triggers a reconnect.
 */
export class RuntimeHealthMonitor {
  private readonly options: HealthMonitorOptions;
  private readonly timers: Timers;
  private readonly listeners = new Set<HealthListener>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private last: HealthProbeResult | undefined;
  private checking = false;

  constructor(options: HealthMonitorOptions) {
    this.options = options;
    this.timers = options.timers ?? defaultTimers();
  }

  /**
   * Registers a listener that is called on every healthy↔unhealthy transition
   * (and once for the initial observation). Returns an unsubscribe function.
   */
  onHealthChange(listener: HealthListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.timer !== undefined) return;
    const interval = this.options.intervalMs ?? 10_000;
    this.timer = this.timers.setInterval(() => {
      void this.tick();
    }, interval);
    // Probe immediately so the UI gets a result without waiting a full interval.
    void this.tick();
  }

  stop(): void {
    if (this.timer === undefined) return;
    this.timers.clearInterval(this.timer);
    this.timer = undefined;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  get lastResult(): HealthProbeResult | undefined {
    return this.last;
  }

  /** Runs a single probe immediately (bypasses the interval). */
  async checkOnce(): Promise<HealthProbeResult> {
    const url = this.options.serverUrl();
    if (!url) {
      const result: HealthProbeResult = { healthy: false, reason: "No server URL configured" };
      this.emitIfNeeded(result);
      return result;
    }
    const result = await probeHealth(url, {
      fetchFn: this.options.fetchFn,
      timeoutMs: this.options.timeoutMs,
      headers: this.options.headers?.(),
      timers: this.timers,
    });
    this.emitIfNeeded(result);
    return result;
  }

  private async tick(): Promise<void> {
    // Skip a beat if the previous probe is still in flight (slow server).
    if (this.checking) return;
    this.checking = true;
    try {
      await this.checkOnce();
    } catch (error) {
      // checkOnce never throws; keep the invariant anyway so a monitoring
      // bug can never take down the interval.
      this.options.logger?.warn("Health probe crashed", errorMessage(error));
    } finally {
      this.checking = false;
    }
  }

  private emitIfNeeded(result: HealthProbeResult): void {
    const previous = this.last;
    this.last = result;
    if (previous !== undefined && previous.healthy === result.healthy) return;
    for (const listener of this.listeners) {
      try {
        listener(result);
      } catch (error) {
        this.options.logger?.warn("Health listener failed", errorMessage(error));
      }
    }
  }
}

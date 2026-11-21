/**
 * Shared fakes for the runtime unit tests. Nothing here spawns a real
 * process or touches the network.
 *
 * Design notes for determinism:
 * - `FakeReadable` replays writes made *before* a `data` listener attaches
 *   synchronously during the attach call (plain PassThrough defers buffered
 *   data by a turn, which races with exit-driven resolution).
 * - Fake children configured with `autoExit` emit their exit event only once
 *   an `exit` listener has attached (Node fires `exit` exactly once; a
 *   pre-scheduled exit would be lost before spawn-time listeners exist).
 * - Signal-driven exits use native promise jobs, which vitest fake timers do
 *   not intercept — unlike `queueMicrotask`.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnOptions } from "node:child_process";
import type { Log } from "../../../src/core/logger";
import type { ManagedProcess, SpawnFn } from "../../../src/runtime/exec";

class FakeReadable extends PassThrough {
  private pending: string[] = [];
  private attached = false;

  writeLine(text: string): void {
    const line = `${text}\n`;
    if (!this.attached) {
      this.pending.push(line);
      return;
    }
    super.write(line);
  }

  override on(event: string, listener: (...args: any[]) => void): this {
    if (event === "data" && !this.attached) {
      this.attached = true;
      super.on(event, listener);
      const buffered = this.pending;
      this.pending = [];
      for (const chunk of buffered) {
        listener(chunk);
      }
      return this;
    }
    return super.on(event, listener);
  }
}

export class FakeChild extends EventEmitter implements ManagedProcess {
  readonly pid: number;
  readonly stdout: FakeReadable = new FakeReadable();
  readonly stderr: FakeReadable = new FakeReadable();
  readonly signals: Array<NodeJS.Signals | number> = [];
  /** When set, the child exits as soon as an `exit` listener attaches. */
  autoExit: { code: number | null; signal?: NodeJS.Signals | null } | null = null;
  /** Signals this fake honors by exiting (SIGKILL always kills a real process). */
  autoExitOn: NodeJS.Signals[] = [];
  killed = false;
  private exitEmitted = false;

  constructor(pid = 4242) {
    super();
    this.pid = pid;
  }

  override on(event: string, listener: (...args: any[]) => void): this {
    if (event === "exit" && this.autoExit !== null && !this.exitEmitted) {
      this.exitEmitted = true;
      const { code, signal } = this.autoExit;
      void Promise.resolve().then(() => this.emitExit(code, signal ?? null));
    }
    return super.on(event, listener);
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.killed = true;
    if (this.autoExitOn.includes(signal as NodeJS.Signals)) {
      void Promise.resolve().then(() => this.emitExit(null, signal as NodeJS.Signals));
    }
    return true;
  }

  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitEmitted = true;
    this.emit("exit", code, signal);
  }

  emitError(error: Error): void {
    this.emit("error", error);
  }

  writeLine(line: string, stream: "stdout" | "stderr" = "stdout"): void {
    (stream === "stdout" ? this.stdout : this.stderr).writeLine(line);
  }
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options?: SpawnOptions;
}

/**
 * A spawn function handing out the provided children in order. When the
 * script runs dry, the fallback child exits immediately with code 1
 * (simulating a binary that fails right away).
 */
export function spawnScript(children: FakeChild[]): { spawnFn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const next = children.shift();
    if (next !== undefined) return next;
    const fallback = new FakeChild();
    // A real process dies on SIGKILL; keep teardown bounded in tests.
    fallback.autoExitOn = ["SIGKILL"];
    fallback.autoExit = { code: 1 };
    return fallback;
  };
  return { spawnFn, calls };
}

/** A child that prints `versionOutput` and exits with `exitCode`. */
export function versionChild(versionOutput: string, exitCode = 0): FakeChild {
  const child = new FakeChild();
  child.writeLine(versionOutput);
  child.autoExit = { code: exitCode };
  return child;
}

/** A child that produces no output and exits immediately. */
export function silentChild(exitCode = 0, stderrOutput = ""): FakeChild {
  const child = new FakeChild();
  if (stderrOutput.length > 0) child.writeLine(stderrOutput, "stderr");
  child.autoExit = { code: exitCode };
  return child;
}

export interface LogRecord {
  level: string;
  message: string;
  data?: string;
}

/** In-memory Log implementation for asserting that secrets never leak. */
export class FakeLogger implements Log {
  readonly records: LogRecord[] = [];

  debug(message: string, data?: unknown): void {
    this.push("debug", message, data);
  }

  info(message: string, data?: unknown): void {
    this.push("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.push("warn", message, data);
  }

  error(message: string, data?: unknown): void {
    this.push("error", message, data);
  }

  private push(level: string, message: string, data: unknown): void {
    this.records.push({
      level,
      message,
      data:
        data === undefined
          ? undefined
          : typeof data === "string"
            ? data
            : JSON.stringify(data),
    });
  }

  /** Everything ever logged, as one string — for secret-leak assertions. */
  allText(): string {
    return JSON.stringify(this.records);
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function statusResponse(status: number): Response {
  return new Response("", { status });
}

/** Flushes pending promise jobs without advancing fake timers. */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

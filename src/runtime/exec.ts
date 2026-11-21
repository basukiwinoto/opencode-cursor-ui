/**
 * Child-process plumbing shared by the runtime layer.
 *
 * Everything here is DI-friendly: `SpawnFn` is a narrow structural type that
 * `child_process.spawn` satisfies, so tests can inject fake processes without
 * spawning anything real. No module in `src/runtime` may import `vscode`.
 */

import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";

/**
 * The slice of `ChildProcess` the runtime layer relies on. `ChildProcess` is
 * structurally assignable to this, and so are test fakes.
 */
export interface ManagedProcess {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  /** Matches the generic EventEmitter/ChildProcess overload shape. */
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnFn = (command: string, args: readonly string[], options?: SpawnOptions) => ManagedProcess;

export const defaultSpawn: SpawnFn = (command, args, options) => spawn(command, args, options ?? {});

/** Human-readable message for unknown error values (never throws). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Error raised when a process could not be spawned at all (e.g. ENOENT). */
export class ExecError extends Error {
  readonly code?: string;

  constructor(message: string, options?: { cause?: unknown; code?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options?.code;
  }
}

export interface CompletedProcess {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  /** Kill the process (with `killSignal`) after this many ms. 0/undefined disables. */
  timeoutMs?: number;
  /** Signal used when the timeout fires. Defaults to SIGKILL (cannot be ignored). */
  killSignal?: NodeJS.Signals;
  /** Max characters retained per stream for diagnostics (tail). Default 16 KiB. */
  maxBufferChars?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Wrap the command in a shell. Only enable for Windows `.cmd`/`.bat` shims
   * (see `windowsShellNeeded`) — we never run remote scripts through a shell,
   * and every argument we pass is an extension-generated constant.
   */
  windowsShell?: boolean;
}

/**
 * Spawns a process, collects stdout/stderr (tail-capped), and resolves on
 * exit. Rejects with `ExecError` only when the process cannot spawn;
 * non-zero exits are resolved, leaving classification to the caller.
 */
export async function runToCompletion(
  spawnFn: SpawnFn,
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<CompletedProcess> {
  const child = spawnFn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: options.windowsShell ?? false,
    cwd: options.cwd,
    env: options.env,
  });

  let stdout = "";
  let stderr = "";
  const cap = options.maxBufferChars ?? 16_384;
  const attach = (stream: NodeJS.ReadableStream | null, append: (text: string) => void): void => {
    stream?.on("data", (chunk: unknown) => {
      append(toText(chunk));
    });
  };
  attach(child.stdout, (text) => {
    stdout = appendTail(stdout, text, cap);
  });
  attach(child.stderr, (text) => {
    stderr = appendTail(stderr, text, cap);
  });

  return await new Promise<CompletedProcess>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      action();
    };

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill(options.killSignal ?? "SIGKILL");
      }, options.timeoutMs);
    }

    child.on("error", (error: Error) => {
      finish(() => {
        reject(
          new ExecError(`Failed to run ${command}: ${errorMessage(error)}`, {
            cause: error,
            code: (error as NodeJS.ErrnoException).code,
          }),
        );
      });
    });
    child.on("exit", (code, signal) => {
      // Defer by one microtask: stdio 'data' events scheduled when the
      // listeners attached (or buffered beforehand) run before this callback,
      // so the captured streams are complete when the promise settles.
      void Promise.resolve().then(() => {
        finish(() => {
          resolve({ code, signal, stdout, stderr, timedOut });
        });
      });
    });
  });
}

/** Windows cannot execute `.cmd`/`.bat` shims without a shell. Safe here: args are constants. */
export function windowsShellNeeded(executablePath: string, isWindows: boolean): boolean {
  return isWindows && /\.(cmd|bat)$/i.test(executablePath);
}

export function appendTail(current: string, addition: string, maxChars: number): string {
  const combined = current + addition;
  return combined.length > maxChars ? combined.slice(combined.length - maxChars) : combined;
}

/** Decodes a stdio chunk (string, Buffer, or Uint8Array) to UTF-8 text. */
export function toText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return "";
}
/**
 * RuntimeManager — supervises an OpenCode server in managed or external mode.
 *
 * Managed mode (we own the process):
 * - Allocates a free port on 127.0.0.1 and spawns
 *   `opencode serve --hostname 127.0.0.1 --port <port>` (cwd = workspace root).
 * - Verified contract: the server prints two stdout lines —
 *     `server listening on http://127.0.0.1:<port>`
 *     `server password <token>`
 * - Waits until `GET /api/info` answers 200 with HTTP Basic auth
 *   (`Basic base64("opencode:" + password)`) before reporting "running".
 * - SIGTERM → 5s grace → SIGKILL on stop. On unexpected exit it enters
 *   "reconnecting" and restarts with exponential backoff (1s, 2s, 4s, … max
 *   30s, 5 attempts) before surfacing "error".
 *
 * External mode (someone else's process):
 * - Discovers the shared local service via `@opencode/client`'s
 *   `Service.discover()` (registration file
 *   `~/.local/state/opencode/service.json`), or connects to an explicit
 *   `{url, password}`. `stop()` only disconnects — we never kill processes we
 *   do not own, and we never call the SDK's `Service.stop()` implicitly.
 *
 * Secret handling: the server password is held in memory only, is never
 * logged (stderr excerpts are scrubbed), never returned by `managedInfo()` /
 * `toString()`, and is exposed exclusively through `getAuthHeaders()`.
 *
 * No `vscode` import: everything (spawn, fetch, timers, discovery, settings,
 * credentials) is injected. The extension layer wires `getSettings` to
 * `readSettings()`, `getPassword` to SecretStorage, and `platform` to
 * `{ remoteName: vscode.env.remoteName }`.
 */

import { createServer } from "node:net";
import { Service } from "@opencode/client/service";
import type { Log } from "../core/logger";
import type { RuntimeMode, RuntimeState } from "../../shared/protocol";
import { appendTail, defaultSpawn, errorMessage, toText, windowsShellNeeded } from "./exec";
import type { ManagedProcess, SpawnFn } from "./exec";
import { defaultTimers, probeHealth } from "./runtimeHealthMonitor";
import type { Timers } from "./runtimeHealthMonitor";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Settings slice the manager reads (structurally satisfied by ExtensionSettings). */
export interface RuntimeSettingsShape {
  runtimeMode?: RuntimeMode;
  executablePath?: string;
  startupTimeoutMs?: number;
  externalServerUrl?: string;
}

/** VS Code wiring passes `{ remoteName: vscode.env.remoteName }`. */
export interface ManagerPlatformHint {
  remoteName?: string | null;
}

/** A discovered/explicit external service endpoint. */
export interface ServiceEndpoint {
  url: string;
  auth?: { type: "basic"; username: string; password: string } | undefined;
}

export interface RuntimeManagerOptions {
  logger?: Log;
  getSettings?: () => RuntimeSettingsShape;
  platform?: ManagerPlatformHint;
  spawnFn?: SpawnFn;
  /** Free-port allocator (defaults to a net server on port 0 bound to 127.0.0.1). */
  freePortFn?: () => Promise<number>;
  fetchFn?: typeof fetch;
  /**
   * Credential callback for external mode — wire to SecretStorage. The
   * password is used only to build Basic auth headers and is never logged.
   */
  getPassword?: () => Promise<string | undefined>;
  /** Overrides `Service.discover()` from @opencode/client (tests inject a fake). */
  discoverService?: () => Promise<ServiceEndpoint | undefined>;
  timers?: Timers;
  /** Overrides settings.runtime.startupTimeoutMs. Default 30_000. */
  startupTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL. Default 5_000. */
  stopGraceMs?: number;
  /** Health-poll cadence while starting. Default 250ms. */
  startupPollMs?: number;
  /**
   * Busy guard consulted before stopping a managed server (the extension
   * layer wires a confirmation dialog when a session is streaming). Returning
   * false refuses the stop with `StopRefusedError`.
   */
  shouldStop?: () => boolean | Promise<boolean>;
  reconnect?: { baseDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
}

export type StartOptions = string | { workspaceRoot?: string };
export type ConnectExternalOptions = { url?: string; password?: string };

/** State-change listener; returns an unsubscribe handle (also `dispose()`-able). */
export type StateListener = (state: RuntimeState, detail?: string) => void;
export type RuntimeUnsubscribe = { (): void; dispose(): void };

/** Info about a managed runtime. The password is deliberately never included. */
export interface ManagedRuntimeInfo {
  executablePath: string;
  port: number;
  serverUrl: string;
  pid?: number;
  /** Never populated — the password is only available via `getAuthHeaders()`. */
  readonly password?: undefined;
}

/** Base class for runtime-manager failures; carries an actionable `hint`. */
export class RuntimeError extends Error {
  readonly hint?: string;

  constructor(message: string, options?: { cause?: unknown; hint?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.hint = options?.hint;
  }
}

/** The managed server failed to start or never became healthy. */
export class RuntimeStartError extends RuntimeError {}
/** Stop was refused by the injected `shouldStop` confirmation callback. */
export class StopRefusedError extends RuntimeError {}

/** Internal marker: the launch was superseded by stop()/a newer start(). */
class StartSupersededError extends RuntimeError {
  constructor() {
    super("The start attempt was superseded by a newer lifecycle operation.");
  }
}

const BASIC_USERNAME = "opencode";
const SERVER_URL_LINE_RE = /server listening on (https?:\/\/\S+)/;
const SERVER_PASSWORD_LINE_RE = /server password (\S+)/;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
const DEFAULT_STARTUP_POLL_MS = 250;
const DEFAULT_RECONNECT = { baseDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5 } as const;

/**
 * Produces the HTTP Basic header for the verified auth scheme
 * (`opencode:<password>`), exported for reuse by adapters.
 */
export function basicAuthHeaderValue(password: string): string {
  return `Basic ${Buffer.from(`${BASIC_USERNAME}:${password}`, "utf8").toString("base64")}`;
}

/**
 * Allocates a free TCP port by binding a net server to port 0 on 127.0.0.1
 * and closing it again (the canonical Node idiom; races are possible but
 * acceptable for a local dev server).
 */
export async function defaultFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", (error) => {
      reject(new RuntimeError(`Could not allocate a free TCP port: ${errorMessage(error)}`, { cause: error }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close(() => {
        if (port !== undefined && port > 0) resolve(port);
        else reject(new RuntimeError("Could not allocate a free TCP port."));
      });
    });
  });
}

function defaultDiscoverService(): Promise<ServiceEndpoint | undefined> {
  return Service.discover();
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface ManagedSession {
  epoch: number;
  child: ManagedProcess;
  exited: boolean;
  exitPromise: Promise<ExitInfo>;
  resolveExit: (info: ExitInfo) => void;
  stderrTail: string;
}

export class RuntimeManager {
  private readonly options: RuntimeManagerOptions;
  private readonly timers: Timers;
  private readonly listeners = new Set<StateListener>();

  private currentState: RuntimeState = "stopped";
  private currentMode: RuntimeMode | undefined;
  private epoch = 0;
  private stopping = false;
  private lastDetail: string | undefined;

  private session: ManagedSession | undefined;
  private managedPort: number | undefined;
  private managedServerUrl: string | undefined;
  private managedExecutablePath: string | undefined;
  private managedPid: number | undefined;
  /** Server password — memory only; never logged, never exposed except via getAuthHeaders(). */
  private managedPassword: string | undefined;
  private externalUrl: string | undefined;
  private externalPassword: string | undefined;
  private observedVersion: string | undefined;
  private lastWorkspaceRoot: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;

  constructor(options: RuntimeManagerOptions = {}) {
    this.options = options;
    this.timers = options.timers ?? defaultTimers();
  }

  // -- queries ---------------------------------------------------------------

  state(): RuntimeState {
    return this.currentState;
  }

  /** Alias of `state()` used by the controller API. */
  getState(): RuntimeState {
    return this.currentState;
  }

  /** The connection mode actually in use, or undefined before first connect. */
  mode(): RuntimeMode | undefined {
    return this.currentMode;
  }

  /** Effective mode for display: current mode, else the configured default. */
  getMode(): RuntimeMode {
    return this.currentMode ?? this.getSettings().runtimeMode ?? "managed";
  }

  getServerUrl(): string | undefined {
    return this.managedServerUrl ?? this.externalUrl;
  }

  /** Alias of `getServerUrl()`. */
  serverUrl(): string | undefined {
    return this.getServerUrl();
  }

  getPid(): number | undefined {
    return this.managedPid;
  }

  /** Version reported by the server's /api/info (best effort). */
  getVersion(): string | undefined {
    return this.observedVersion;
  }

  getMeta(): { executablePath?: string; pid?: number; serverUrl?: string } {
    return {
      executablePath: this.managedExecutablePath,
      pid: this.managedPid,
      serverUrl: this.getServerUrl(),
    };
  }

  /** Managed runtime facts. The password field is never populated. */
  managedInfo(): ManagedRuntimeInfo | undefined {
    if (
      this.currentMode !== "managed" ||
      this.managedServerUrl === undefined ||
      this.managedPort === undefined ||
      this.managedExecutablePath === undefined
    ) {
      return undefined;
    }
    return {
      executablePath: this.managedExecutablePath,
      port: this.managedPort,
      serverUrl: this.managedServerUrl,
      pid: this.managedPid,
    };
  }

  /** Redacted summary — safe for logs; never includes the password. */
  toString(): string {
    return `RuntimeManager(mode=${this.currentMode ?? "unset"}, state=${this.currentState}, url=${this.getServerUrl() ?? "none"}, pid=${this.managedPid ?? "none"})`;
  }

  onStateChange(listener: StateListener): RuntimeUnsubscribe {
    this.listeners.add(listener);
    const handle: RuntimeUnsubscribe = Object.assign(
      () => {
        this.listeners.delete(listener);
      },
      {
        dispose: () => {
          this.listeners.delete(listener);
        },
      },
    );
    return handle;
  }

  // -- lifecycle ---------------------------------------------------------------

  /**
   * Starts the runtime. In managed mode this allocates a free port, spawns
   * `opencode serve`, waits for the startup lines and a healthy /api/info.
   * When settings select external mode, this delegates to `connectExternal()`.
   * Accepts a bare workspace-root string (controller convenience) or options.
   */
  async start(options: StartOptions = {}): Promise<void> {
    const workspaceRoot = typeof options === "string" ? options : options.workspaceRoot;
    if (workspaceRoot !== undefined && workspaceRoot.length > 0) this.lastWorkspaceRoot = workspaceRoot;
    if (this.getSettings().runtimeMode === "external") {
      await this.connectExternal();
      return;
    }
    // Idempotent: tear down any previous runtime (live child, timers, state).
    await this.stop();
    const myEpoch = ++this.epoch;
    this.currentMode = "managed";
    this.setState("starting");
    try {
      await this.launchManaged(this.lastWorkspaceRoot, myEpoch);
    } catch (error) {
      if (error instanceof StartSupersededError || this.epoch !== myEpoch) return;
      this.setState("error", this.redact(errorMessage(error)));
      throw error;
    }
  }

  /**
   * Stops the runtime. Managed: SIGTERM → grace → SIGKILL after the injected
   * `shouldStop` guard passes. External: disconnect only — we never stop
   * processes we do not own.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    try {
      this.epoch += 1; // invalidate pending launches/reconnect attempts
      this.clearReconnectTimer();
      if (this.currentMode === "external") {
        await this.disconnect();
        return;
      }
      const session = this.session;
      if (!session || session.exited) {
        this.clearConnectionState();
        this.setState("stopped");
        return;
      }
      if (this.options.shouldStop) {
        const allowed = await this.options.shouldStop();
        if (!allowed) {
          throw new StopRefusedError(
            "Stop refused: an OpenCode session is busy and the confirmation callback declined.",
            { hint: "Interrupt the running session first, then stop the runtime again." },
          );
        }
      }
      await this.terminate(session, this.stopGraceMs());
      this.clearConnectionState();
      this.setState("stopped");
    } finally {
      this.stopping = false;
    }
  }

  /** Stop + start (or reconnect for external mode). */
  async restart(options: StartOptions = {}): Promise<void> {
    const workspaceRoot = typeof options === "string" ? options : options.workspaceRoot;
    await this.stop();
    await this.start(workspaceRoot ?? {});
  }

  /**
   * Re-establish the connection: re-discover/re-connect external servers,
   * restart the managed server. No-op while a reconnect is already scheduled.
   */
  async reconnect(): Promise<void> {
    const settings = this.getSettings();
    if (this.currentMode === "external" || (this.currentMode === undefined && settings.runtimeMode === "external")) {
      await this.connectExternal();
      return;
    }
    if (this.currentState === "reconnecting") return;
    if (this.currentState === "running" || this.currentState === "starting") {
      await this.restart(this.lastWorkspaceRoot ?? {});
      return;
    }
    await this.start(this.lastWorkspaceRoot ?? {});
  }

  /**
   * Connects to an external OpenCode server: explicit `{url, password}`, the
   * configured `external.serverUrl`, or shared-service discovery via
   * `@opencode/client`. The password may come from the injected
   * `getPassword()` callback (SecretStorage) — it is kept in memory only.
   */
  async connectExternal(options: ConnectExternalOptions = {}): Promise<void> {
    await this.stop();
    const myEpoch = ++this.epoch;
    this.setState("starting");
    try {
      const settings = this.getSettings();
      let url = options.url?.trim() || settings.externalServerUrl?.trim() || "";
      let discovered: ServiceEndpoint | undefined;
      if (url.length === 0) {
        discovered = await this.discover();
        if (this.epoch !== myEpoch) return;
        if (!discovered) {
          throw new RuntimeError("No running OpenCode service was found on this machine.", {
            hint: "Start one with `opencode serve --service`, or set opencodeCursorUI.external.serverUrl to connect explicitly.",
          });
        }
        url = discovered.url;
      }
      let password: string | undefined = options.password;
      if (password === undefined && discovered?.auth?.password !== undefined) password = discovered.auth.password;
      if (password === undefined) password = await this.options.getPassword?.();
      if (this.epoch !== myEpoch) return;

      const headers: Record<string, string> = {};
      if (password !== undefined) headers["Authorization"] = basicAuthHeaderValue(password);
      const result = await probeHealth(url, {
        fetchFn: this.fetchFn(),
        headers,
        timers: this.timers,
      });
      if (this.epoch !== myEpoch) return;
      if (!result.healthy) {
        throw new RuntimeError(`The OpenCode server at ${url} is not healthy: ${result.reason}`, {
          hint: "Verify the URL and that the server is running a compatible version exposing /api/info (HTTP Basic auth).",
        });
      }
      this.currentMode = "external";
      this.externalUrl = url;
      this.externalPassword = password;
      this.observedVersion = result.version ?? this.observedVersion;
      this.clearManagedRuntimeFields();
      this.reconnectAttempts = 0;
      this.setState("running");
    } catch (error) {
      if (error instanceof StartSupersededError || this.epoch !== myEpoch) return;
      this.setState("error", errorMessage(error));
      throw error;
    }
  }

  /**
   * Drops all connection state (and the password from memory) without
   * killing any process. For a managed server use `stop()` to terminate it.
   */
  async disconnect(): Promise<void> {
    this.epoch += 1;
    this.clearReconnectTimer();
    this.clearConnectionState();
    this.setState("stopped");
  }

  /** Stops (without throwing) and detaches all listeners. */
  async dispose(): Promise<void> {
    try {
      await this.stop();
    } catch (error) {
      this.logger()?.warn("Runtime dispose failed", errorMessage(error));
    }
    this.listeners.clear();
  }

  /**
   * Hook for the health monitor: an unhealthy managed server triggers a
   * reconnect (kill the wedged process if any, then backoff-restart).
   */
  onUnhealthy(reason: string): void {
    if (this.currentMode !== "managed" || this.currentState !== "running") return;
    this.logger()?.warn("Health monitor reported the managed server as unhealthy", reason);
    const myEpoch = ++this.epoch;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.clearManagedRuntimeFields();
    void (async () => {
      const session = this.session;
      if (session && !session.exited) {
        await this.terminate(session, this.stopGraceMs());
      }
      if (this.epoch !== myEpoch) return;
      this.scheduleReconnect(reason);
    })();
  }

  // -- auth ----------------------------------------------------------------

  /**
   * HTTP headers for OpenCode API calls. Returns `{}` when the server runs
   * without a password; otherwise the verified Basic scheme
   * (`Authorization: Basic base64("opencode:" + password)`). This is the ONLY
   * place the password leaves this class.
   */
  async getAuthHeaders(): Promise<Record<string, string>> {
    const password = await this.currentPassword();
    if (password === undefined || password.length === 0) return {};
    return { Authorization: basicAuthHeaderValue(password) };
  }

  private async currentPassword(): Promise<string | undefined> {
    if (this.currentMode === "managed") return this.managedPassword;
    if (this.currentMode === "external") {
      if (this.externalPassword !== undefined) return this.externalPassword;
      return await this.options.getPassword?.();
    }
    return undefined;
  }

  // -- internals ------------------------------------------------------------

  private logger(): Log | undefined {
    return this.options.logger;
  }

  private getSettings(): RuntimeSettingsShape {
    return this.options.getSettings?.() ?? {};
  }

  private stopGraceMs(): number {
    return this.options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  private startupTimeoutMs(): number {
    return this.options.startupTimeoutMs ?? this.getSettings().startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  private startupPollMs(): number {
    return this.options.startupPollMs ?? DEFAULT_STARTUP_POLL_MS;
  }

  private reconnectConfig(): { baseDelayMs: number; maxDelayMs: number; maxAttempts: number } {
    return { ...DEFAULT_RECONNECT, ...this.options.reconnect };
  }

  private spawnFn(): SpawnFn {
    return this.options.spawnFn ?? defaultSpawn;
  }

  private fetchFn(): typeof fetch {
    return this.options.fetchFn ?? fetch;
  }

  private freePortFn(): () => Promise<number> {
    return this.options.freePortFn ?? defaultFreePort;
  }

  private async discover(): Promise<ServiceEndpoint | undefined> {
    try {
      const discover = this.options.discoverService ?? defaultDiscoverService;
      return await discover();
    } catch (error) {
      this.logger()?.warn("OpenCode service discovery failed", errorMessage(error));
      return undefined;
    }
  }

  private setState(state: RuntimeState, detail?: string): void {
    const changed = this.currentState !== state || detail !== this.lastDetail;
    this.currentState = state;
    this.lastDetail = detail;
    if (!changed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(state, detail);
      } catch (error) {
        this.logger()?.warn("State listener failed", errorMessage(error));
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.timers.setTimeout(resolve, ms);
    });
  }

  /** Rejects with `RuntimeStartError` once the (fake-clock aware) deadline passes. */
  private timeoutAt(deadline: number, message: string): Promise<never> {
    const remaining = Math.max(0, deadline - Date.now());
    return new Promise<never>((_resolve, reject) => {
      this.timers.setTimeout(() => {
        reject(new RuntimeStartError(message));
      }, remaining);
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearManagedRuntimeFields(): void {
    this.session = undefined;
    this.managedPort = undefined;
    this.managedServerUrl = undefined;
    this.managedPid = undefined;
    this.managedPassword = undefined;
  }

  private clearConnectionState(): void {
    this.clearManagedRuntimeFields();
    this.externalUrl = undefined;
    this.externalPassword = undefined;
    this.observedVersion = undefined;
  }

  /** Scrubs the server password out of diagnostic text (defense in depth). */
  private redact(text: string): string {
    for (const secret of [this.managedPassword, this.externalPassword]) {
      if (secret !== undefined && secret.length > 0) {
        text = text.split(secret).join("[REDACTED]");
      }
    }
    return text;
  }

  private stderrExcerpt(): string {
    const tail = this.session?.stderrTail.trim() ?? "";
    return tail.length > 0 ? ` Server stderr (tail): ${this.redact(tail.slice(-400))}` : "";
  }

  // -- managed lifecycle ------------------------------------------------------

  private async launchManaged(workspaceRoot: string | undefined, myEpoch: number): Promise<void> {
    const settings = this.getSettings();
    const executablePath = settings.executablePath?.trim() || "opencode";
    const port = await this.freePortFn()();
    if (this.epoch !== myEpoch) throw new StartSupersededError();

    const child = this.spawnFn()(
      executablePath,
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: workspaceRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Windows: npm-created .cmd shims require a shell. Safe — all args are
        // extension-generated constants (no user input is interpolated).
        shell: windowsShellNeeded(executablePath, process.platform === "win32"),
      },
    );

    const session: ManagedSession = {
      epoch: myEpoch,
      child,
      exited: false,
      exitPromise: undefined as unknown as Promise<ExitInfo>,
      resolveExit: () => undefined,
      stderrTail: "",
    };
    session.exitPromise = new Promise<ExitInfo>((resolveExit) => {
      session.resolveExit = resolveExit;
    });
    this.session = session;
    this.managedPort = port;
    this.managedExecutablePath = executablePath;
    this.managedPid = typeof child.pid === "number" ? child.pid : undefined;
    this.managedPassword = undefined;
    this.managedServerUrl = undefined;

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      session.exited = true;
      session.resolveExit({ code, signal });
      this.handleUnexpectedExit(session, code, signal);
    });
    child.on("error", (error: Error) => {
      session.stderrTail = appendTail(session.stderrTail, `${errorMessage(error)}\n`, 4_000);
      if (!session.exited) {
        session.exited = true;
        session.resolveExit({ code: null, signal: null, error });
      }
      this.handleUnexpectedExit(session, null, null, error);
    });
    child.stderr?.on("data", (chunk: unknown) => {
      session.stderrTail = appendTail(session.stderrTail, toText(chunk), 4_000);
    });

    const urlSeen = new Promise<string>((resolveUrl) => {
      let buffer = "";
      child.stdout?.on("data", (chunk: unknown) => {
        // child_process delivers Buffers by default — decode before matching.
        buffer += toText(chunk);
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          // The server prints "listening" BEFORE "password" — keep parsing
          // after the URL so the password line is never missed. resolveUrl is
          // idempotent per promise, so repeat URL lines are harmless.
          const url = SERVER_URL_LINE_RE.exec(line)?.[1];
          if (url !== undefined) {
            resolveUrl(url);
          }
          const password = SERVER_PASSWORD_LINE_RE.exec(line)?.[1];
          if (password !== undefined) {
            this.managedPassword = password;
          }
          newlineIndex = buffer.indexOf("\n");
        }
      });
    });

    const deadline = Date.now() + this.startupTimeoutMs();
    let serverUrl: string;
    try {
      serverUrl = await Promise.race([
        urlSeen,
        session.exitPromise.then((info) => {
          throw new RuntimeStartError(
            `The OpenCode server exited during startup (${describeExit(info)}).${this.stderrExcerpt()}`,
            { hint: "Run the serve command in a terminal for the full error output." },
          );
        }),
        this.timeoutAt(
          deadline,
          `Timed out after ${this.startupTimeoutMs()}ms waiting for the OpenCode server to print its listening address.`,
        ),
      ]);
    } catch (error) {
      await this.terminate(session, this.stopGraceMs());
      throw error;
    }
    if (this.epoch !== myEpoch) throw new StartSupersededError();

    this.managedServerUrl = serverUrl;
    if (this.managedPassword === undefined) {
      this.logger()?.warn("The OpenCode server did not print a startup password; continuing without Basic auth.");
    }

    try {
      await this.waitUntilHealthy(session, serverUrl, myEpoch, deadline);
    } catch (error) {
      // A wedged server must not be left running: tear it down before
      // surfacing the failure (unless a newer lifecycle op already took over).
      if (!(error instanceof StartSupersededError) && this.epoch === myEpoch) {
        await this.terminate(session, this.stopGraceMs());
      }
      throw error;
    }
    if (this.epoch !== myEpoch) throw new StartSupersededError();
    this.reconnectAttempts = 0;
    this.setState("running");
  }

  private async waitUntilHealthy(
    session: ManagedSession,
    serverUrl: string,
    myEpoch: number,
    deadline: number,
  ): Promise<void> {
    for (;;) {
      if (this.epoch !== myEpoch) throw new StartSupersededError();
      const result = await probeHealth(serverUrl, {
        fetchFn: this.fetchFn(),
        headers: await this.getAuthHeaders(),
        timers: this.timers,
      });
      if (result.healthy) {
        this.observedVersion = result.version ?? this.observedVersion;
        return;
      }
      if (session.exited) {
        throw new RuntimeStartError(
          `The OpenCode server exited before becoming healthy (last check: ${result.reason}).${this.stderrExcerpt()}`,
          { hint: "Run the serve command in a terminal for the full error output." },
        );
      }
      if (Date.now() >= deadline) {
        throw new RuntimeStartError(
          `The OpenCode server did not become healthy within ${this.startupTimeoutMs()}ms (last check: ${result.reason}).`,
        );
      }
      await this.delay(this.startupPollMs());
    }
  }

  private handleUnexpectedExit(
    session: ManagedSession,
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ): void {
    if (session.epoch !== this.epoch) return; // stale launch, superseded by stop()/start()
    if (this.stopping) return; // intentional shutdown in progress
    if (this.currentState !== "running") return; // startup failures flow through start()
    const detail = error !== undefined
      ? errorMessage(error)
      : `process exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "none"})`;
    this.logger()?.warn("The managed OpenCode server exited unexpectedly", detail);
    this.clearManagedRuntimeFields();
    this.scheduleReconnect(detail);
  }

  private scheduleReconnect(detail?: string): void {
    const config = this.reconnectConfig();
    if (this.reconnectAttempts >= config.maxAttempts) {
      this.setState("error", `Reconnect failed after ${config.maxAttempts} attempts. ${detail ?? ""}`.trim());
      return;
    }
    // Exponential backoff: 1s, 2s, 4s, … capped at maxDelayMs.
    const delay = Math.min(config.baseDelayMs * 2 ** this.reconnectAttempts, config.maxDelayMs);
    this.reconnectAttempts += 1;
    this.setState("reconnecting", detail);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnectAttempt();
    }, delay);
  }

  private async reconnectAttempt(): Promise<void> {
    if (this.currentMode !== "managed" || this.currentState !== "reconnecting") return;
    const myEpoch = ++this.epoch;
    try {
      await this.launchManaged(this.lastWorkspaceRoot, myEpoch);
    } catch (error) {
      if (error instanceof StartSupersededError || this.epoch !== myEpoch) return;
      this.logger()?.warn("Reconnect attempt failed", errorMessage(error));
      this.scheduleReconnect(errorMessage(error));
    }
  }

  // -- process teardown ---------------------------------------------------------

  /**
   * SIGTERM → wait `graceMs` → SIGKILL → wait.
   * Windows note: Node emulates both signals via TerminateProcess (there is
   * no graceful SIGTERM on win32); the grace period simply bounds how long we
   * wait for the `exit` event.
   */
  private async terminate(session: ManagedSession, graceMs: number): Promise<void> {
    if (session.child.pid === undefined) return;
    session.child.kill("SIGTERM");
    const graceful = await this.waitForExitFor(session, graceMs);
    if (!graceful) {
      session.child.kill("SIGKILL");
      await this.waitForExitFor(session, Math.max(graceMs, 1_000));
    }
  }

  private async waitForExitFor(session: ManagedSession, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        session.exitPromise.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = this.timers.setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) this.timers.clearTimeout(timer);
    }
  }
}

function describeExit(info: ExitInfo): string {
  if (info.error !== undefined) return errorMessage(info.error);
  if (info.code !== null) return `exit code ${info.code}`;
  return `signal ${info.signal ?? "none"}`;
}

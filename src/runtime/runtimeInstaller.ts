/**
 * Detection, installation, and update of the OpenCode CLI.
 *
 * Detection priority (per opencodeCursorUI.runtime.executablePath semantics):
 *   1. custom path from settings → `--version` probe
 *   2. `opencode` resolved from PATH (Windows also probes `opencode.cmd`/`.exe`)
 *   3. managed install at `<globalStorage>/managed-runtime/node_modules/.bin/opencode`
 *
 * Installation shells out to the npm CLI (`npm install opencode@<version>
 * --prefix <managedDir>`). We never pipe remote scripts into a shell and we
 * never interpolate user input into spawn arguments.
 *
 * User approval for installs/updates is the CALLER's responsibility (the
 * extension layer shows the confirmation dialog); the installer assumes
 * approval and only reports typed, actionable failures.
 *
 * Windows nuances (documented where behavior differs):
 * - npm on Windows is `npm.cmd` and requires a shell to execute; Node cannot
 *   spawn `.cmd` shims directly.
 * - PATH resolution honors `;` delimiters and Windows executable names.
 * - SIGTERM/SIGKILL distinction does not exist on Windows (Node emulates
 *   both via TerminateProcess), which only affects graceful-stop timing, not
 *   this module.
 *
 * WSL/remote nuance: when VS Code is connected to a remote (ssh/wsl/container),
 * extension-host code — including this installer — runs on the remote host,
 * so PATH probing and managed installs target the remote filesystem.
 */

import { access as fsAccess, constants as fsConstants, mkdir as fsMkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Log } from "../core/logger";
import type { InstallProgress } from "../../shared/protocol";
import { defaultSpawn, errorMessage, runToCompletion, windowsShellNeeded } from "./exec";
import type { SpawnFn } from "./exec";
import {
  BinaryNotWorkingError,
  NPM_REGISTRY_URL,
  ReleaseVerifierError,
  VersionMismatchError,
  fetchReleaseMetadata,
  runBinaryVersion,
} from "./releaseVerifier";
import type { ReleaseMetadata } from "./releaseVerifier";
import { MIN_OPENCODE_VERSION, isVersionAtLeast } from "./types";
import type { DetectedRuntime, InstallMethod } from "./types";
import type { PlatformInfo } from "../../shared/protocol";
import { compareVersions } from "./version";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InstallProgressListener = (progress: InstallProgress) => void;

export interface InstallerSettings {
  /** opencodeCursorUI.runtime.executablePath (may be empty = auto-detect). */
  executablePath?: string;
}

/** VS Code wiring passes `{ remoteName: vscode.env.remoteName }`. */
export interface InstallerPlatformHint {
  remoteName?: string | null;
}

export interface RuntimeInstallerOptions {
  logger?: Log;
  getSettings?: () => InstallerSettings;
  platform?: InstallerPlatformHint;
  /** Managed install root, e.g. `<globalStorage>/managed-runtime`. */
  managedBaseDir: string;
  spawnFn?: SpawnFn;
  fetchFn?: typeof fetch;
  /** Existence probe override (defaults to fs.access with X_OK). */
  fileExists?: (path: string) => Promise<boolean>;
  mkdir?: (path: string) => Promise<void>;
  /** PATH environment override (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Windows simulation for tests; defaults to process.platform === "win32". */
  isWindows?: boolean;
  /** Version probe override (defaults to releaseVerifier.runBinaryVersion). */
  runVersion?: VersionProbe;
  /** npm install timeout. Default 10 minutes. */
  npmTimeoutMs?: number;
  /** `opencode upgrade` timeout for external installs. Default 10 minutes. */
  upgradeTimeoutMs?: number;
}

export type VersionProbe = (executablePath: string) => Promise<{ version: string }>;

export interface InstallOptions {
  version?: string;
  onProgress?: InstallProgressListener;
}

export interface InstallResult {
  version: string;
  executablePath: string;
  /** SRI hash of the installed release as published in the npm registry. */
  integrity?: string;
}

export interface UpdateRequest {
  executablePath: string;
  /** Target version; omit to install the registry's latest. */
  toVersion?: string;
  onProgress?: InstallProgressListener;
  /**
   * Post-update verification for managed installs; a rejection triggers a
   * rollback to the previously working version.
   */
  healthCheck?: () => Promise<void>;
  /**
   * External installs only: when provided and it resolves true, the installer
   * executes `opencode upgrade` (the official CLI updater); otherwise the
   * caller gets a manual instruction instead. This is the explicit-approval
   * hook the extension layer wires to its confirmation dialog.
   */
  approveUpgrade?: () => Promise<boolean>;
}

export type UpdateOptions = Omit<UpdateRequest, "executablePath">;

export type UpdateResult =
  | { status: "updated"; executablePath: string; version: string; previousVersion?: string }
  | { status: "manual"; executablePath: string; instruction: string };

/** Base class for installer failures; carries an actionable `hint`. */
export class InstallError extends Error {
  readonly hint?: string;

  constructor(message: string, options?: { cause?: unknown; hint?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.hint = options?.hint;
  }
}

/** A managed update failed, the previous version was restored, and the original failure is preserved as `cause`. */
export class UpdateRolledBackError extends InstallError {
  readonly from?: string;
  readonly to?: string;

  constructor(message: string, options?: { cause?: unknown; hint?: string; from?: string; to?: string }) {
    super(message, options);
    this.from = options?.from;
    this.to = options?.to;
  }
}

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

const NO_PROGRESS: InstallProgressListener = () => undefined;

interface NpmCommand {
  command: string;
  windowsShell: boolean;
}

export class RuntimeInstaller {
  private readonly logger?: Log;
  private readonly getSettings: () => InstallerSettings;
  private readonly managedBaseDir: string;
  private readonly spawnFn: SpawnFn;
  private readonly fetchFn: typeof fetch;
  private readonly fileExists: (path: string) => Promise<boolean>;
  private readonly mkdirFn: (path: string) => Promise<void>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly isWindows: boolean;
  private readonly runVersion: VersionProbe;
  private readonly npmTimeoutMs: number;
  private readonly upgradeTimeoutMs: number;
  private readonly platformHint: InstallerPlatformHint | undefined;

  constructor(options: RuntimeInstallerOptions) {
    this.logger = options.logger;
    this.getSettings = options.getSettings ?? (() => ({}));
    this.managedBaseDir = resolve(options.managedBaseDir);
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.fetchFn = options.fetchFn ?? fetch;
    this.fileExists = options.fileExists ?? defaultFileExists;
    this.mkdirFn = options.mkdir ?? defaultMkdir;
    this.env = options.env ?? process.env;
    this.isWindows = options.isWindows ?? process.platform === "win32";
    const spawnFn = this.spawnFn;
    const isWindows = this.isWindows;
    this.runVersion =
      options.runVersion ?? ((executablePath: string) => runBinaryVersion(executablePath, { spawnFn, isWindows }));
    this.npmTimeoutMs = options.npmTimeoutMs ?? 600_000;
    this.upgradeTimeoutMs = options.upgradeTimeoutMs ?? 600_000;
    this.platformHint = options.platform;
  }

  // -- detection ------------------------------------------------------------

  async detect(): Promise<DetectedRuntime> {
    const custom = this.getSettings().executablePath?.trim();
    if (custom) {
      // The user pinned an executable: report its state honestly instead of
      // silently falling back to PATH.
      return await this.probe(custom, "custom");
    }
    const onPath = await this.findOnPath(this.executableNames());
    if (onPath) {
      return await this.probe(onPath, "existing");
    }
    const managed = await this.findManagedExecutable();
    if (managed) {
      return await this.probe(managed, "managed");
    }
    // Nothing found anywhere. `method: "existing"` maps to SetupInfo.detection
    // "none" in the controller (custom→custom, managed→managed, otherwise
    // installed ? "path" : "none").
    return { installed: false, method: "existing" };
  }

  /** Platform facts for the current host (remote-aware via the injected hint). */
  platformInfo(): PlatformInfo {
    const raw = this.platformHint?.remoteName;
    const remote = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
    return { os: process.platform, arch: process.arch, remote, isRemote: remote !== null };
  }

  // -- install ---------------------------------------------------------------

  async install(options: InstallOptions = {}): Promise<InstallResult> {
    return await this.installToManagedDir({ version: options.version, onProgress: options.onProgress });
  }

  /**
   * Update flow.
   * - Managed installs (executable inside the managed dir): reinstall the
   *   pinned/latest version via npm; if the injected `healthCheck` (or the
   *   install verification) fails afterwards, reinstall the previous version
   *   and throw `UpdateRolledBackError`.
   * - External installs: by default return a manual instruction to run
   *   `opencode upgrade`; with `approveUpgrade` resolving true the installer
   *   executes `opencode upgrade` itself.
   */
  async update(request: string | UpdateRequest, options: UpdateOptions = {}): Promise<UpdateResult> {
    const req: UpdateRequest =
      typeof request === "string"
        ? { executablePath: request, ...options }
        : { ...request, ...stripUndefined(options) };
    const executablePath = req.executablePath;
    const onProgress = req.onProgress ?? NO_PROGRESS;

    if (!this.isManagedPath(executablePath)) {
      return await this.updateExternal(executablePath, req);
    }
    return await this.updateManaged(executablePath, req, onProgress);
  }

  /** Latest version published on the npm registry, or undefined when unreachable. */
  async latestVersion(): Promise<string | undefined> {
    try {
      const metadata = await fetchReleaseMetadata(undefined, this.fetchFn);
      return metadata.version;
    } catch (error) {
      this.logger?.warn("Could not determine the latest OpenCode version", errorMessage(error));
      return undefined;
    }
  }

  /** The executable path a successful managed install produces. */
  managedExecutablePath(): string {
    // `npm install --prefix <dir>` puts the package's bin shim into
    // <dir>/node_modules/.bin. Windows gets the .cmd shim (spawned via shell).
    return join(this.managedBaseDir, "node_modules", ".bin", this.isWindows ? "opencode.cmd" : "opencode");
  }

  isManagedPath(executablePath: string): boolean {
    const managedRoot = resolve(this.managedBaseDir) + sep;
    return resolve(executablePath).startsWith(managedRoot);
  }

  // -- internals ---------------------------------------------------------------

  private async probe(executablePath: string, method: InstallMethod): Promise<DetectedRuntime> {
    try {
      const { version } = await this.runVersion(executablePath);
      if (!isVersionAtLeast(version, MIN_OPENCODE_VERSION)) {
        return {
          installed: true,
          version,
          executablePath,
          method,
          compatError:
            `OpenCode ${version} at ${executablePath} is older than the minimum supported version ${MIN_OPENCODE_VERSION}. ` +
            "Update it (`opencode upgrade`) or install a newer release.",
        };
      }
      return { installed: true, version, executablePath, method };
    } catch (error) {
      return {
        installed: false,
        method,
        compatError: `Found ${executablePath} but it is not runnable: ${errorMessage(error)}`,
      };
    }
  }

  private executableNames(): string[] {
    // Windows: npm creates `opencode.cmd` shims; native installers may drop `opencode.exe`.
    return this.isWindows ? ["opencode.cmd", "opencode.exe", "opencode"] : ["opencode"];
  }

  private async findOnPath(names: string[]): Promise<string | undefined> {
    const pathValue = this.env.PATH ?? this.env.Path ?? "";
    if (pathValue.trim().length === 0) return undefined;
    // Windows uses ";" as the PATH delimiter; every other platform uses ":".
    const delimiter = this.isWindows ? ";" : ":";
    const candidates: string[] = [];
    for (const dir of pathValue.split(delimiter)) {
      const trimmed = dir.trim();
      if (trimmed.length === 0) continue;
      for (const name of names) {
        candidates.push(join(trimmed, name));
      }
    }
    for (const candidate of candidates) {
      if (await this.fileExists(candidate)) return candidate;
    }
    return undefined;
  }

  private async findManagedExecutable(): Promise<string | undefined> {
    const binDir = join(this.managedBaseDir, "node_modules", ".bin");
    for (const name of this.executableNames()) {
      const candidate = join(binDir, name);
      if (await this.fileExists(candidate)) return candidate;
    }
    return undefined;
  }

  private async resolveNpm(): Promise<NpmCommand> {
    // Prefer the npm CLI that ships with the Node runtime running this
    // extension (process.execPath's directory), then fall back to PATH.
    const besideNode = join(dirname(process.execPath), this.isWindows ? "npm.cmd" : "npm");
    if (await this.fileExists(besideNode)) {
      return { command: besideNode, windowsShell: this.isWindows };
    }
    const onPath = await this.findOnPath(this.isWindows ? ["npm.cmd", "npm"] : ["npm"]);
    if (onPath) {
      return { command: onPath, windowsShell: this.isWindows };
    }
    throw new InstallError("npm was not found next to the Node runtime or on PATH.", {
      hint: "npm not found — install Node.js (https://nodejs.org) and reopen VS Code, or set opencodeCursorUI.runtime.executablePath to an existing OpenCode binary.",
    });
  }

  private async ensureManagedDir(): Promise<void> {
    await this.mkdirFn(this.managedBaseDir);
  }

  private async installToManagedDir(options: {
    version?: string;
    onProgress?: InstallProgressListener;
    onNpmComplete?: () => void;
  }): Promise<InstallResult> {
    const onProgress = options.onProgress ?? NO_PROGRESS;
    onProgress({ phase: "checking", message: "Resolving npm and OpenCode release metadata…" });
    const npm = await this.resolveNpm();

    let metadata: ReleaseMetadata;
    try {
      metadata = await fetchReleaseMetadata(options.version, this.fetchFn);
    } catch (error) {
      throw new InstallError(`Could not resolve the OpenCode release to install: ${errorMessage(error)}`, {
        cause: error,
        hint: `Check network access to ${NPM_REGISTRY_URL} and retry.`,
      });
    }

    await this.ensureManagedDir();
    onProgress({
      phase: "downloading",
      message: `Downloading opencode@${metadata.version} via npm…`,
    });
    await this.npmInstall(npm, metadata.version);
    options.onNpmComplete?.();
    // npm performs download/extract/link internally; its non-zero exit or the
    // post-install verification below covers those phases.

    onProgress({
      phase: "verifying",
      message: `Verifying the installed OpenCode binary (expected ${metadata.version})…`,
    });
    const executablePath = this.managedExecutablePath();
    let version: string;
    try {
      version = (await this.runVersion(executablePath)).version;
    } catch (error) {
      const cause = error instanceof ReleaseVerifierError ? error : undefined;
      const message = cause ? cause.message : `The managed install could not be verified: ${errorMessage(error)}`;
      onProgress({ phase: "error", message });
      throw new InstallError(message, {
        cause: error,
        hint: `Delete ${this.managedBaseDir} and retry the install.`,
      });
    }
    if (compareVersions(version, metadata.version) !== 0) {
      const cause = new VersionMismatchError(
        `The managed install reports OpenCode ${version}, expected ${metadata.version}.`,
        { hint: `Delete ${this.managedBaseDir} and retry the install.` },
      );
      onProgress({ phase: "error", message: cause.message });
      throw new InstallError(cause.message, { cause, hint: cause.hint });
    }

    onProgress({ phase: "done", message: `Installed OpenCode ${version} at ${executablePath}` });
    return { version, executablePath, integrity: metadata.integrity };
  }

  private async npmInstall(npm: NpmCommand, version: string): Promise<void> {
    const args = [
      "install",
      `opencode@${version}`,
      "--prefix",
      this.managedBaseDir,
      "--no-audit",
      "--no-fund",
      "--loglevel",
      "error",
    ];
    const result = await runToCompletion(this.spawnFn, npm.command, args, {
      timeoutMs: this.npmTimeoutMs,
      killSignal: "SIGKILL",
      windowsShell: npm.windowsShell,
      cwd: this.managedBaseDir,
    });
    if (result.timedOut) {
      throw new InstallError(`npm install opencode@${version} timed out after ${this.npmTimeoutMs}ms.`, {
        hint: "Check network speed or proxy settings and retry; the npm output (if any) is in the logs.",
      });
    }
    if (result.code !== 0) {
      const reason = result.code === null ? `signal ${result.signal}` : `exit code ${result.code}`;
      const tail = (result.stderr.trim().length > 0 ? result.stderr : result.stdout).trim().slice(-800);
      throw new InstallError(`npm install opencode@${version} failed with ${reason}${tail ? `: ${tail}` : ""}.`, {
        hint: "Check disk space, permissions for the managed directory, and network access to the npm registry.",
      });
    }
  }

  private async currentVersion(executablePath: string): Promise<string | undefined> {
    try {
      return (await this.runVersion(executablePath)).version;
    } catch (error) {
      this.logger?.debug("Could not determine the current OpenCode version", errorMessage(error));
      return undefined;
    }
  }

  private async updateManaged(
    executablePath: string,
    req: UpdateRequest,
    onProgress: InstallProgressListener,
  ): Promise<UpdateResult> {
    const previous = await this.currentVersion(executablePath);
    let replaced = false;
    try {
      const result = await this.installToManagedDir({
        version: req.toVersion,
        onProgress,
        onNpmComplete: () => {
          replaced = true;
        },
      });
      if (req.healthCheck) {
        await req.healthCheck();
      }
      return {
        status: "updated",
        executablePath: result.executablePath,
        version: result.version,
        previousVersion: previous,
      };
    } catch (error) {
      if (!replaced || previous === undefined) {
        if (error instanceof InstallError) throw error;
        throw new InstallError(`Update failed: ${errorMessage(error)}`, { cause: error });
      }
      // Post-replacement failure (bad verify or failed health check):
      // restore the previously working version before surfacing the error.
      onProgress({ phase: "error", message: `Update failed: ${errorMessage(error)} — rolling back…` });
      this.logger?.warn("Managed update failed; rolling back", errorMessage(error));
      try {
        await this.installToManagedDir({ version: previous, onProgress });
      } catch (rollbackError) {
        throw new InstallError(
          `Update failed (${errorMessage(error)}) AND rollback to ${previous} failed (${errorMessage(rollbackError)}).`,
          {
            cause: error,
            hint: `The managed runtime at ${this.managedBaseDir} may be broken; delete it and reinstall.`,
          },
        );
      }
      throw new UpdateRolledBackError(
        `Update to ${req.toVersion ?? "latest"} failed and the previous version ${previous} was restored: ${errorMessage(error)}`,
        { cause: error, hint: "Inspect the logged failure before retrying the update.", from: previous, to: req.toVersion },
      );
    }
  }

  private async updateExternal(executablePath: string, req: UpdateRequest): Promise<UpdateResult> {
    const instruction =
      `OpenCode at ${executablePath} is not managed by this extension. ` +
      "Run `opencode upgrade` (alias `opencode update`) in a terminal to update it.";
    if (!req.approveUpgrade) {
      return { status: "manual", executablePath, instruction };
    }
    const approved = await req.approveUpgrade();
    if (!approved) {
      return { status: "manual", executablePath, instruction };
    }
    const previous = await this.currentVersion(executablePath);
    const result = await runToCompletion(this.spawnFn, executablePath, ["upgrade"], {
      timeoutMs: this.upgradeTimeoutMs,
      killSignal: "SIGKILL",
      windowsShell: windowsShellNeeded(executablePath, this.isWindows),
    });
    if (result.timedOut) {
      throw new InstallError(`"opencode upgrade" timed out after ${this.upgradeTimeoutMs}ms.`, {
        hint: "Run `opencode upgrade` in a terminal to see the full output.",
      });
    }
    if (result.code !== 0) {
      const reason = result.code === null ? `signal ${result.signal}` : `exit code ${result.code}`;
      const tail = result.stderr.trim().slice(-400);
      throw new InstallError(`"opencode upgrade" failed with ${reason}${tail ? `: ${tail}` : ""}.`, {
        hint: "Run `opencode upgrade` in a terminal to see the full output.",
      });
    }
    let version: string;
    try {
      version = (await this.runVersion(executablePath)).version;
    } catch (error) {
      throw new InstallError(`"opencode upgrade" finished but the binary no longer runs: ${errorMessage(error)}`, {
        cause: error,
        hint: instruction,
      });
    }
    return { status: "updated", executablePath, version, previousVersion: previous };
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    // X_OK: on POSIX this checks executability; on Windows it effectively
    // checks existence, which is the right behavior for .cmd shims.
    await fsAccess(path, fsConstants.X_OK);
    return true;
  } catch {
    // Any failure (ENOENT, EACCES, ELOOP, …) means "not usable as an
    // executable"; probes report the reason when a candidate was selected.
    return false;
  }
}

async function defaultMkdir(path: string): Promise<void> {
  // recursive: true is a no-op when the directory already exists.
  await fsMkdir(path, { recursive: true });
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) {
      (result as Record<string, unknown>)[key] = val;
    }
  }
  return result;
}

// Re-exported so the extension layer can classify installer errors without
// importing the verifier directly.
export { ReleaseVerifierError, VersionMismatchError, BinaryNotWorkingError };

/**
 * Platform detection for the runtime layer.
 *
 * VS Code specifics are injected instead of imported: the extension layer
 * wires `remoteName: () => vscode.env.remoteName`, while OS/arch come from
 * Node's `process` (or an explicit override for tests). This keeps
 * `src/runtime` free of `vscode` imports.
 *
 * Remote nuances (documented for the extension layer):
 * - `vscode.env.remoteName` is `undefined` locally and a non-empty string for
 *   ssh-remote/wsl/devcontainer/codespaces sessions. Empty strings are
 *   normalized to `null` (treated as local).
 * - When connected to a remote, the extension host runs on the REMOTE
 *   machine, so `process.platform` already reflects the remote OS for
 *   extension-host-side code (the managed server is spawned there too).
 */

import { homedir as nodeHomedir } from "node:os";
import { join } from "node:path";
import type { PlatformInfo } from "../../shared/protocol";
import type { IPlatformResolver, PlatformContext } from "./types";

/** A remote name: static string, getter, or absent. */
export type RemoteNameInput = string | null | undefined | (() => string | null | undefined);

export interface PlatformResolverOptions {
  /** Node platform identifier, e.g. "darwin". Defaults to process.platform. */
  platform?: string;
  /** Node architecture identifier, e.g. "arm64". Defaults to process.arch. */
  arch?: string;
  /** vscode.env.remoteName (value or getter). Defaults to undefined = local. */
  remoteName?: RemoteNameInput;
  /** User home directory override. Defaults to os.homedir(). */
  homedir?: string;
}

/** Normalizes VS Code's remoteName (undefined locally, possibly empty) to `string | null`. */
export function normalizeRemoteName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function detectPlatform(options: PlatformResolverOptions = {}): PlatformInfo {
  const os = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const rawRemote = typeof options.remoteName === "function" ? options.remoteName() : options.remoteName;
  const remote = normalizeRemoteName(rawRemote);
  return { os, arch, remote, isRemote: remote !== null };
}

/**
 * Maps OS/arch to the npm platform-binary package that ships the OpenCode
 * binary (installed as an optional dependency of `opencode`). Returns
 * `undefined` for unsupported combinations — notably linux/musl (Alpine),
 * which the verified package list does not cover.
 */
export function binaryPackageName(os: string, arch: string): string | undefined {
  switch (os) {
    case "darwin":
      return arch === "arm64" ? "opencode-darwin-arm64" : arch === "x64" ? "opencode-darwin-x64" : undefined;
    case "linux":
      return arch === "x64" ? "opencode-linux-x64" : arch === "arm64" ? "opencode-linux-arm64" : undefined;
    case "win32":
      return arch === "x64" ? "opencode-win32-x64" : undefined;
    default:
      return undefined;
  }
}

/**
 * Default location of the shared-service registration file
 * (`~/.local/state/opencode/service.json`, XDG state dir) as written by
 * `opencode serve --service`. On Windows the @opencode/client SDK picks a
 * different per-user location itself; this helper documents the POSIX/XDG
 * default used by the SDK's `fallback()`.
 */
export function serviceRegistrationPath(homedirPath: string): string {
  return join(homedirPath, ".local", "state", "opencode", "service.json");
}

export class PlatformResolver implements IPlatformResolver {
  private readonly cachedContext: PlatformContext;

  constructor(private readonly options: PlatformResolverOptions = {}) {
    // `detect()` is re-evaluated on every access so an injected remoteName
    // getter (VS Code remotes can appear/disconnect mid-session) stays live.
    const detect = (): PlatformInfo => detectPlatform(options);
    this.cachedContext = {
      get platform(): PlatformInfo {
        return detect();
      },
      binaryPackageName: () => {
        const info = detect();
        return binaryPackageName(info.os, info.arch);
      },
      isWindows: () => detect().os === "win32",
      isMacOS: () => detect().os === "darwin",
      isLinux: () => detect().os === "linux",
    };
  }

  get context(): PlatformContext {
    return this.cachedContext;
  }

  homedir(): string {
    return this.options.homedir ?? nodeHomedir();
  }
}

/**
 * Factory used by the extension layer. VS Code wiring (a `remoteName` getter
 * backed by `vscode.env.remoteName`) happens at the call site; OS/arch come
 * from Node's process object.
 */
export function createPlatformResolver(options: PlatformResolverOptions = {}): PlatformResolver {
  return new PlatformResolver(options);
}

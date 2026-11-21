import type { PlatformInfo } from "../../shared/protocol";

export type InstallMethod = "managed" | "existing" | "custom";

export interface DetectedRuntime {
  installed: boolean;
  version?: string;
  executablePath?: string;
  method: InstallMethod;
  compatError?: string;
}

export interface PlatformContext {
  readonly platform: PlatformInfo;
  /** Platform binary package name for npm optional dependencies, e.g. opencode-darwin-arm64. */
  binaryPackageName(): string | undefined;
  isWindows(): boolean;
  isMacOS(): boolean;
  isLinux(): boolean;
}

/** Resolves OS/architecture/remote facts for the current session. */
export interface IPlatformResolver {
  readonly context: PlatformContext;
}

export const MIN_OPENCODE_VERSION = "2.0.0";

/** True when `version` >= `min` (semver-ish, tolerant of `v` prefixes and 2-4 components). */
export function isVersionAtLeast(version: string, min: string): boolean {
  const parse = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(/[.\-+]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  return true;
}

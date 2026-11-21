/**
 * Release verification against the npm registry and local binaries.
 *
 * Facts this builds on (verified against OpenCode v2.2.6):
 * - The official npm package is `opencode`; `https://registry.npmjs.org/opencode`
 *   exposes `dist-tags.latest` and per-version `dist.tarball` + `dist.integrity`
 *   (SRI `sha512-…`). Platform binaries are optional deps such as
 *   `opencode-darwin-arm64`.
 * - `opencode --version` prints `opencode v2.2.6`.
 *
 * All network/spawn access is injectable so tests never touch the network and
 * never spawn a real `opencode` process.
 */

import { createHash } from "node:crypto";
import { defaultSpawn, errorMessage, ExecError, runToCompletion, windowsShellNeeded } from "./exec";
import type { SpawnFn } from "./exec";
import { compareVersions, extractVersionToken } from "./version";

export const OPENCODE_NPM_PACKAGE = "opencode";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org/opencode";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Base class for release-verification failures; carries an actionable `hint`. */
export class ReleaseVerifierError extends Error {
  readonly hint?: string;

  constructor(message: string, options?: { cause?: unknown; hint?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.hint = options?.hint;
  }
}

/** The npm registry could not be reached or answered with an error. */
export class RegistryUnavailableError extends ReleaseVerifierError {}
/** The registry responded but the payload shape was not the expected package metadata. */
export class MetadataValidationError extends ReleaseVerifierError {}
/** The requested version does not exist in the registry. */
export class VersionNotFoundError extends ReleaseVerifierError {}
/** A downloaded tarball does not match the registry's SRI integrity hash. */
export class IntegrityMismatchError extends ReleaseVerifierError {}
/** An installed binary reports a different version than expected. */
export class VersionMismatchError extends ReleaseVerifierError {}
/** An installed binary could not be executed or its output could not be understood. */
export class BinaryNotWorkingError extends ReleaseVerifierError {}

// ---------------------------------------------------------------------------
// Registry metadata
// ---------------------------------------------------------------------------

export interface RegistryDist {
  tarball?: string;
  integrity?: string;
  shasum?: string;
}

export interface RegistryVersionEntry {
  version?: string;
  dist?: RegistryDist;
}

export interface RegistryPackageMetadata {
  name: string;
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, RegistryVersionEntry>;
}

export interface ReleaseMetadata {
  version: string;
  tarballUrl: string;
  /** SRI string, e.g. "sha512-…", as published in the registry entry. */
  integrity: string;
}

/**
 * Validates the shape of npm package metadata without assuming anything
 * beyond what the registry documents. Throws `MetadataValidationError` with an
 * actionable message when the payload does not look like package metadata.
 */
export function verifyRegistryMetadata(json: unknown): RegistryPackageMetadata {
  const contextHint = `Verify network access to ${NPM_REGISTRY_URL} (a proxy or captive portal may be returning an HTML error page).`;
  if (typeof json !== "object" || json === null) {
    throw new MetadataValidationError("The npm registry response is not a JSON object.", { hint: contextHint });
  }
  const record = json as Record<string, unknown>;
  const name = record["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new MetadataValidationError('The npm registry metadata is missing the "name" field.', { hint: contextHint });
  }

  const result: RegistryPackageMetadata = { name };

  const distTags = record["dist-tags"];
  if (distTags !== undefined) {
    if (typeof distTags !== "object" || distTags === null) {
      throw new MetadataValidationError('The npm registry metadata has a non-object "dist-tags" field.', {
        hint: contextHint,
      });
    }
    const tags: Record<string, string> = {};
    for (const [tag, value] of Object.entries(distTags)) {
      if (typeof value !== "string") {
        throw new MetadataValidationError(`The npm registry "dist-tags.${tag}" entry is not a string.`, {
          hint: contextHint,
        });
      }
      tags[tag] = value;
    }
    result["dist-tags"] = tags;
  }

  const versions = record["versions"];
  if (versions !== undefined) {
    if (typeof versions !== "object" || versions === null || Array.isArray(versions)) {
      throw new MetadataValidationError('The npm registry metadata has a non-object "versions" field.', {
        hint: contextHint,
      });
    }
    const entries: Record<string, RegistryVersionEntry> = {};
    for (const [key, value] of Object.entries(versions)) {
      if (typeof value !== "object" || value === null) {
        throw new MetadataValidationError(`The npm registry version entry "${key}" is not an object.`, {
          hint: contextHint,
        });
      }
      const versionRecord = value as Record<string, unknown>;
      const entry: RegistryVersionEntry = {};
      if (versionRecord["version"] !== undefined) {
        if (typeof versionRecord["version"] !== "string") {
          throw new MetadataValidationError(`The npm registry version entry "${key}" has a non-string "version".`, {
            hint: contextHint,
          });
        }
        entry.version = versionRecord["version"];
      }
      const dist = versionRecord["dist"];
      if (dist !== undefined) {
        if (typeof dist !== "object" || dist === null) {
          throw new MetadataValidationError(`The npm registry version entry "${key}" has a non-object "dist".`, {
            hint: contextHint,
          });
        }
        const distRecord = dist as Record<string, unknown>;
        const validated: RegistryDist = {};
        if (distRecord["tarball"] !== undefined) {
          if (typeof distRecord["tarball"] !== "string") {
            throw new MetadataValidationError(`The npm registry version entry "${key}" has a non-string "dist.tarball".`, {
              hint: contextHint,
            });
          }
          validated.tarball = distRecord["tarball"];
        }
        if (distRecord["integrity"] !== undefined) {
          if (typeof distRecord["integrity"] !== "string") {
            throw new MetadataValidationError(
              `The npm registry version entry "${key}" has a non-string "dist.integrity".`,
              { hint: contextHint },
            );
          }
          validated.integrity = distRecord["integrity"];
        }
        if (distRecord["shasum"] !== undefined) {
          if (typeof distRecord["shasum"] !== "string") {
            throw new MetadataValidationError(`The npm registry version entry "${key}" has a non-string "dist.shasum".`, {
              hint: contextHint,
            });
          }
          validated.shasum = distRecord["shasum"];
        }
        entry.dist = validated;
      }
      entries[key] = entry;
    }
    result.versions = entries;
  }

  return result;
}

/**
 * Fetches release metadata for `version` (or `dist-tags.latest` when no
 * version is given) from the npm registry.
 *
 * The returned `integrity` is the registry's SRI hash; npm enforces it during
 * `npm install`. Use `assertTarballIntegrity` when downloading a tarball
 * directly.
 */
export async function fetchReleaseMetadata(
  version?: string,
  fetchFn: typeof fetch = fetch,
  options?: { timeoutMs?: number },
): Promise<ReleaseMetadata> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Request to the npm registry timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  let response: Response;
  try {
    response = await fetchFn(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new RegistryUnavailableError(`Could not reach the npm registry at ${NPM_REGISTRY_URL}: ${errorMessage(error)}`, {
      cause: error,
      hint: "Check network connectivity (or proxy/VPN settings) and retry the install.",
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new RegistryUnavailableError(
      `The npm registry returned HTTP ${response.status}${response.statusText ? ` (${response.statusText})` : ""} for ${NPM_REGISTRY_URL}.`,
      { hint: "The registry may be down or blocking this network; retry later or check proxy settings." },
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new RegistryUnavailableError("The npm registry returned a response that is not valid JSON.", {
      cause: error,
      hint: "A proxy or captive portal may be intercepting registry traffic; retry on a different network.",
    });
  }

  const metadata = verifyRegistryMetadata(json);
  const requested = version?.trim() || metadata["dist-tags"]?.["latest"];
  if (!requested) {
    throw new MetadataValidationError(
      'The npm registry metadata has no "dist-tags.latest" entry and no explicit version was requested.',
      { hint: `The "${OPENCODE_NPM_PACKAGE}" package metadata looks unusual; retry later or pin a specific version.` },
    );
  }
  const entry = metadata.versions?.[requested];
  if (!entry) {
    throw new VersionNotFoundError(`opencode@${requested} was not found in the npm registry.`, {
      hint: `Check the requested version; available versions are listed under "versions" in ${NPM_REGISTRY_URL}.`,
    });
  }
  const tarball = entry.dist?.tarball;
  if (typeof tarball !== "string" || tarball.length === 0) {
    throw new MetadataValidationError(`The npm registry entry for opencode@${requested} has no tarball URL.`, {
      hint: "The release may have been unpublished; pick another version.",
    });
  }
  const integrity = entry.dist?.integrity;
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new MetadataValidationError(
      `The npm registry entry for opencode@${requested} has no sha512 integrity hash; refusing to install unverifiable release artifacts.`,
      { hint: "Retry later — a healthy registry always publishes dist.integrity (sha512) for recent releases." },
    );
  }
  return { version: requested, tarballUrl: tarball, integrity };
}

// ---------------------------------------------------------------------------
// Tarball integrity
// ---------------------------------------------------------------------------

/** Computes the SRI string (sha512-…) for a tarball payload. */
export function computeSri(data: Uint8Array): string {
  return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

/**
 * Verifies a downloaded tarball against the registry's SRI integrity hash.
 * Throws `IntegrityMismatchError` on any mismatch (corruption or tampering).
 */
export function assertTarballIntegrity(data: Uint8Array, expectedIntegrity: string): void {
  if (!expectedIntegrity.startsWith("sha512-")) {
    throw new MetadataValidationError(
      "Expected integrity must be a sha512 SRI string (sha512-…); refusing a weaker hash algorithm.",
      { hint: "Only sha512 integrity hashes from the npm registry are accepted." },
    );
  }
  const actual = computeSri(data);
  if (actual !== expectedIntegrity) {
    throw new IntegrityMismatchError(
      `Tarball integrity mismatch: expected ${expectedIntegrity}, computed ${actual}.`,
      { hint: "The download may be corrupted or tampered with; clear the npm cache and retry the install." },
    );
  }
}

// ---------------------------------------------------------------------------
// Binary verification
// ---------------------------------------------------------------------------

export interface BinaryVerificationOptions {
  spawnFn?: SpawnFn;
  /** Timeout for the `--version` probe. Default 15s. */
  timeoutMs?: number;
  /** Windows simulation for tests; defaults to process.platform === "win32". */
  isWindows?: boolean;
}

export interface BinaryVersion {
  version: string;
  rawOutput: string;
}

/**
 * Runs `<executable> --version` and parses the reported version
 * (expected format: `opencode v2.2.6`).
 *
 * Windows nuance: `.cmd` shims (npm global installs) must run through a
 * shell; every argument here is an extension-generated constant, so enabling
 * `shell` for those paths is safe.
 */
export async function runBinaryVersion(
  executablePath: string,
  options: BinaryVerificationOptions = {},
): Promise<BinaryVersion> {
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const isWindows = options.isWindows ?? process.platform === "win32";
  const timeoutMs = options.timeoutMs ?? 15_000;
  let result: Awaited<ReturnType<typeof runToCompletion>>;
  try {
    result = await runToCompletion(spawnFn, executablePath, ["--version"], {
      timeoutMs,
      windowsShell: windowsShellNeeded(executablePath, isWindows),
    });
  } catch (error) {
    // The process could not even be started (ENOENT, EACCES, …).
    const enoent = error instanceof ExecError && error.code === "ENOENT";
    throw new BinaryNotWorkingError(`Could not run "${executablePath} --version": ${errorMessage(error)}`, {
      cause: error,
      hint: enoent
        ? "The executable does not exist at this path; check opencodeCursorUI.runtime.executablePath."
        : "Verify the file exists, is executable, and is not corrupted.",
    });
  }

  if (result.timedOut) {
    throw new BinaryNotWorkingError(`"${executablePath} --version" timed out after ${timeoutMs}ms.`, {
      hint: "The executable may be hanging or waiting for input; verify it runs from a terminal.",
    });
  }
  if (result.code !== 0) {
    const reason = result.code === null ? `signal ${result.signal}` : `exit code ${result.code}`;
    const details = result.stderr.trim().length > 0 ? `: ${result.stderr.trim().slice(-400)}` : ".";
    throw new BinaryNotWorkingError(`"${executablePath} --version" failed with ${reason}${details}`, {
      hint: `Run "${executablePath} --version" in a terminal to see the full error.`,
    });
  }
  const version = extractVersionToken(result.stdout) ?? extractVersionToken(result.stderr);
  if (!version) {
    throw new BinaryNotWorkingError(
      `Could not parse an OpenCode version from the output of "${executablePath} --version".`,
      { hint: `Expected output like "opencode v2.2.6"; verify this executable is actually OpenCode.` },
    );
  }
  return { version, rawOutput: result.stdout };
}

/**
 * Verifies an installed binary reports exactly `expectedVersion`
 * (prefix-tolerant: `v2.2.6` === `2.2.6`).
 */
export async function verifyInstalledBinary(
  executablePath: string,
  expectedVersion: string,
  options?: BinaryVerificationOptions,
): Promise<BinaryVersion> {
  const found = await runBinaryVersion(executablePath, options);
  if (compareVersions(found.version, expectedVersion) !== 0) {
    throw new VersionMismatchError(
      `The OpenCode binary at ${executablePath} reports version ${found.version}, expected ${expectedVersion}.`,
      {
        hint: "Delete the managed runtime directory and reinstall, or point opencodeCursorUI.runtime.executablePath at the correct executable.",
      },
    );
  }
  return found;
}

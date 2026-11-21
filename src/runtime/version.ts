/**
 * Semver-ish parsing and comparison helpers for OpenCode version strings.
 *
 * OpenCode reports versions like `opencode v2.2.6`; the npm registry uses bare
 * `2.2.6` with optional prerelease/build suffixes. These helpers are tolerant
 * of `v`/`V` prefixes, 2–4 dot components, and prerelease identifiers.
 *
 * `isVersionAtLeast` (the minimum-version gate) lives in `./types` and is
 * re-exported here so callers have a single import site.
 */

import { isVersionAtLeast } from "./types";

export { isVersionAtLeast };

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, e.g. ["beta", "2"] for 2.3.0-beta.2. */
  prerelease: string[];
}

/**
 * Parses a version string into numeric components. Anything unparseable
 * degrades to 0 so comparisons stay deterministic (never NaN).
 */
export function parseVersion(input: string): ParsedVersion {
  const cleaned = input.trim().replace(/^[vV]/, "");
  // Build metadata (+…) never affects precedence; drop it first.
  const withoutBuild = cleaned.split("+", 1)[0] ?? "";
  const dashIndex = withoutBuild.indexOf("-");
  const core = dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex);
  const prerelease = dashIndex === -1 ? "" : withoutBuild.slice(dashIndex + 1);
  const parts = core.split(".");
  const component = (index: number): number => {
    const raw = parts[index] ?? "";
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };
  return {
    major: component(0),
    minor: component(1),
    patch: component(2),
    prerelease: prerelease.length > 0 ? prerelease.split(".").filter((part) => part.length > 0) : [],
  };
}

/**
 * Compares two version strings with semver precedence rules.
 * Returns -1 when `a` < `b`, 0 when equal, 1 when `a` > `b`.
 *
 * Notes:
 * - `v` prefixes are ignored (`v2.2.6` === `2.2.6`).
 * - Missing components are zero (`2.2` === `2.2.0`).
 * - A release outranks its own prereleases (`2.2.6` > `2.2.6-beta`).
 * - Numeric prerelease identifiers compare numerically (`beta.2` < `beta.10`).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

function comparePrerelease(a: readonly string[], b: readonly string[]): -1 | 0 | 1 {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a release outranks its prereleases
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1; // fewer identifiers = lower precedence
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left) ? Number(left) : null;
    const rightNumeric = /^\d+$/.test(right) ? Number(right) : null;
    if (leftNumeric !== null && rightNumeric !== null) {
      if (leftNumeric !== rightNumeric) return leftNumeric < rightNumeric ? -1 : 1;
    } else if (leftNumeric !== null) {
      return -1; // numeric identifiers rank below alphanumeric ones
    } else if (rightNumeric !== null) {
      return 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

/** Extracts a version token (`2.2.6`, `v2.10.0-beta.1`, …) from free-form CLI output. */
export function extractVersionToken(output: string): string | undefined {
  const match = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return match?.[1];
}

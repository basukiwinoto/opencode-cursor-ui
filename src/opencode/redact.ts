/**
 * Secret redaction for OpenCode SDK payloads.
 *
 * `model.settings.apiKey`, `provider.settings`, provider headers and similar
 * fields carry the user's REAL provider credentials. Nothing derived from an
 * SDK payload may reach the webview or the logs before going through
 * `redactSdkPayload` (or one of the `sanitize*Option` projection helpers).
 */

import type { ModelOption, ProviderOption } from "../../shared/protocol";

const REDACTED = "[TRUNCATED-SECRET]" as const;

/** Object keys whose values must never leave the process (case-insensitive). */
const SECRET_KEY_PATTERN = /^(api[-_]?key|password|passwd|secret|authorization|proxy-authorization|token)$/i;

/** String fragments that look like live credentials even without a secret key. */
const SECRET_STRING_PATTERNS: RegExp[] = [
  // sk-… style provider keys (OpenAI & friends).
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  // Inline Basic/Bearer credentials.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]{16,}\b/g,
];

function scrubString(input: string): string {
  let out = input;
  for (const pattern of SECRET_STRING_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Deep-clones `value` while stripping secrets:
 * - any object property named like a credential becomes "[TRUNCATED-SECRET]"
 *   (so `settings.apiKey` is stripped but `settings.baseURL` survives),
 * - every string is scrubbed for `sk-…` / Basic / Bearer fragments,
 * - non-JSON values (functions, symbols, bigints) collapse to `null`.
 *
 * The input is never mutated; the returned structure shares no object with it.
 */
export function redactSdkPayload(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[…]";
  if (typeof value === "string") return scrubString(value);
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return null;
  if (Array.isArray(value)) {
    return value.map((item) => redactSdkPayload(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSdkPayload(item, depth + 1);
  }
  return out;
}

/**
 * Projects a (redacted) SDK `Model.Info` payload into the UI-facing
 * `ModelOption`. Returns `null` when the payload lacks the identifiers needed
 * to address the model. Only scalar, non-secret fields survive.
 */
export function sanitizeModelOption(raw: unknown): ModelOption | null {
  const redacted = redactSdkPayload(raw);
  if (typeof redacted !== "object" || redacted === null || Array.isArray(redacted)) return null;
  const record = redacted as Record<string, unknown>;
  const providerID = asString(record["providerID"]);
  const modelID = asString(record["modelID"]) ?? asString(record["id"]);
  if (!providerID || !modelID) return null;
  return {
    providerID,
    modelID,
    label: asString(record["name"]) ?? modelID,
    family: asString(record["family"]),
    type: asString(record["type"]),
  };
}

/**
 * Projects a (redacted) SDK `Provider.Info` payload into the UI-facing
 * `ProviderOption`. `modelCount` is supplied by the caller, which knows the
 * full model list.
 */
export function sanitizeProviderOption(raw: unknown, modelCount = 0): ProviderOption | null {
  const redacted = redactSdkPayload(raw);
  if (typeof redacted !== "object" || redacted === null || Array.isArray(redacted)) return null;
  const record = redacted as Record<string, unknown>;
  const id = asString(record["id"]);
  if (!id) return null;
  return {
    id,
    name: asString(record["name"]) ?? id,
    activation: asString(record["activation"]),
    modelCount,
  };
}

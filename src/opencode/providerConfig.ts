import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { opencodeConfigPath, type ModelConfigFs, nodeModelConfigFs } from "./modelConfig";

/**
 * Adds/updates OpenAI-compatible custom providers in OpenCode's config file
 * (`provider.<id>` section — the same shape OpenCode documents and the TUI
 * writes). Writes are merge-safe: a timestamped backup is created first and
 * malformed JSON is never overwritten.
 *
 * API keys support the `{env:VAR}` passthrough form the user may prefer so the
 * literal key never touches disk.
 */

export interface CustomProviderInput {
  /** Provider id, e.g. "my-proxy". Must be a URL-safe slug. */
  id: string;
  /** Display name, e.g. "My Proxy". */
  name: string;
  /** OpenAI-compatible base URL. */
  baseURL: string;
  /**
   * API key. Literal secret, or "env:VAR_NAME" to reference an environment
   * variable (written as "{env:VAR_NAME}").
   */
  apiKey?: string;
  /** Model definitions to register under the provider. */
  models?: Array<{ id: string; name?: string; context?: number; output?: number }>;
}

export interface ProviderConfigFs extends ModelConfigFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

export function isValidProviderId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id);
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Renders the API key into OpenCode's option form; env references stay symbolic. */
export function renderApiKey(apiKey: string | undefined): string | undefined {
  if (apiKey === undefined || apiKey.trim().length === 0) return undefined;
  const trimmed = apiKey.trim();
  const envMatch = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (envMatch?.[1]) return `{env:${envMatch[1]}}`;
  return trimmed;
}

export interface WriteProviderResult {
  ok: boolean;
  backupPath?: string;
  error?: string;
}

export async function writeCustomProvider(
  input: CustomProviderInput,
  fsApi: ModelConfigFs = nodeModelConfigFs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WriteProviderResult> {
  if (!isValidProviderId(input.id)) {
    return { ok: false, error: `Invalid provider id "${input.id}" — use letters, digits, dashes.` };
  }
  if (!isHttpUrl(input.baseURL)) {
    return { ok: false, error: `Invalid base URL "${input.baseURL}" — must be http(s).` };
  }

  const file = opencodeConfigPath(undefined, env);
  let raw: string | undefined;
  try {
    raw = await fsApi.readFile(file, "utf8");
  } catch {
    raw = undefined;
  }

  if (raw !== undefined) {
    try {
      JSON.parse(raw);
    } catch (error) {
      return { ok: false, error: `OpenCode config is not valid JSON (${file}): ${String(error)}` };
    }
  }

  const config = raw !== undefined ? (JSON.parse(raw) as Record<string, unknown>) : { $schema: "https://opencode.ai/config.json" };
  const providers = (typeof config.provider === "object" && config.provider !== null && !Array.isArray(config.provider)
    ? { ...(config.provider as Record<string, unknown>) }
    : {}) as Record<string, unknown>;

  const options: Record<string, unknown> = {};
  const baseURL = input.baseURL.replace(/\/+$/, "");
  options.baseURL = baseURL;
  const apiKey = renderApiKey(input.apiKey);
  if (apiKey !== undefined) options.apiKey = apiKey;

  const models: Record<string, unknown> = {};
  for (const model of input.models ?? []) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(model.id)) {
      return { ok: false, error: `Invalid model id "${model.id}".` };
    }
    const entry: Record<string, unknown> = { name: model.name ?? model.id };
    const limit: Record<string, number> = {};
    if (model.context !== undefined) limit.context = model.context;
    if (model.output !== undefined) limit.output = model.output;
    if (Object.keys(limit).length > 0) entry.limit = limit;
    models[model.id] = entry;
  }

  providers[input.id] = {
    ...(providers[input.id] as Record<string, unknown> | undefined),
    name: input.name,
    npm: "@ai-sdk/openai-compatible",
    options,
    ...(Object.keys(models).length > 0 ? { models } : {}),
  };
  config.provider = providers;

  const contents = `${JSON.stringify(config, null, 2)}\n`;

  let backupPath: string | undefined;
  if (raw !== undefined) {
    backupPath = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await fsApi.copyFile(file, backupPath);
    } catch (error) {
      return { ok: false, error: `Could not create a config backup: ${String(error)}` };
    }
  }

  try {
    await fsApi.mkdir(path.dirname(file), { recursive: true });
  } catch {
    // EEXIST is fine; the write surfaces real failures.
  }

  try {
    await fsApi.writeFile(file, contents);
  } catch (error) {
    return { ok: false, error: `Could not write ${file}: ${String(error)}` };
  }
  return { ok: true, backupPath };
}

export function defaultConfigDir(homedir: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return path.dirname(opencodeConfigPath(homedir, env));
}

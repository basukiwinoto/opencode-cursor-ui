import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRef } from "../../shared/protocol";

/**
 * Reads/writes OpenCode's default model in the official config file
 * (`~/.config/opencode/opencode.json`, key `"model": "providerID/modelID"` —
 * the same key the CLI and TUI use). Writes are merge-safe: unknown keys are
 * preserved, a timestamped backup is created first, and malformed JSON is
 * never overwritten.
 */

export interface ModelConfigFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  access(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
}

export const nodeModelConfigFs: ModelConfigFs = {
  readFile: (p, e) => fs.promises.readFile(p, e),
  writeFile: (p, d) => fs.promises.writeFile(p, d, "utf8"),
  copyFile: (s, d) => fs.promises.copyFile(s, d),
  access: (p) => fs.promises.access(p),
  mkdir: (p, o) => fs.promises.mkdir(p, o),
};

export interface WriteDefaultModelResult {
  ok: boolean;
  backupPath?: string;
  error?: string;
}

/** Resolves the OpenCode config file path (XDG-aware, documented Windows fallback). */
export function opencodeConfigPath(homedir: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME ?? path.join(homedir, ".config");
  return path.join(base, "opencode", "opencode.json");
}

/** Parses `"providerID/modelID[/variant]"` into a ModelRef, or undefined. */
export function parseModelString(value: string | undefined): ModelRef | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return undefined;
  const providerID = parts[0];
  const modelID = parts[1];
  if (providerID === undefined || modelID === undefined) return undefined;
  const variantParts = parts.slice(2);
  return { providerID, modelID, variant: variantParts.length > 0 ? variantParts.join("/") : undefined };
}

export function formatModelString(ref: ModelRef): string {
  return ref.variant ? `${ref.providerID}/${ref.modelID}/${ref.variant}` : `${ref.providerID}/${ref.modelID}`;
}

export async function readConfigKey(
  key: string,
  fsApi: ModelConfigFs = nodeModelConfigFs,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const file = opencodeConfigPath(undefined, env);
  let raw: string;
  try {
    raw = await fsApi.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeConfigKey(
  key: string,
  value: string,
  fsApi: ModelConfigFs = nodeModelConfigFs,
  env?: NodeJS.ProcessEnv,
): Promise<WriteDefaultModelResult> {
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

  const next = raw !== undefined ? (JSON.parse(raw) as Record<string, unknown>) : { $schema: "https://opencode.ai/config.json" };
  next[key] = value;
  const contents = `${JSON.stringify(next, null, 2)}\n`;

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
    // An existing directory yields EEXIST even with recursive:true on some
    // platforms; the write below surfaces real failures.
  }

  try {
    await fsApi.writeFile(file, contents);
  } catch (error) {
    return { ok: false, error: `Could not write ${file}: ${String(error)}` };
  }
  return { ok: true, backupPath };
}

export async function readDefaultModel(
  fsApi: ModelConfigFs = nodeModelConfigFs,
  env?: NodeJS.ProcessEnv,
): Promise<ModelRef | undefined> {
  return parseModelString(await readConfigKey("model", fsApi, env));
}

export async function writeDefaultModel(
  ref: ModelRef,
  fsApi: ModelConfigFs = nodeModelConfigFs,
  env?: NodeJS.ProcessEnv,
): Promise<WriteDefaultModelResult> {
  return writeConfigKey("model", formatModelString(ref), fsApi, env);
}

export async function readDefaultAgent(fsApi: ModelConfigFs = nodeModelConfigFs, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  const value = await readConfigKey("default_agent", fsApi, env);
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

export async function writeDefaultAgent(
  agentID: string,
  fsApi: ModelConfigFs = nodeModelConfigFs,
  env?: NodeJS.ProcessEnv,
): Promise<WriteDefaultModelResult> {
  return writeConfigKey("default_agent", agentID, fsApi, env);
}

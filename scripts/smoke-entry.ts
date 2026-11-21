/**
 * Live smoke test: exercises the REAL RuntimeManager + OpenCodeClientAdapter
 * against a real `opencode serve` process. No mocks. Read-only API calls only
 * (session create + delete; no LLM prompts).
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { RuntimeManager } from "../src/runtime/runtimeManager";
import { OpenCodeClientAdapter } from "../src/opencode/adapter";
import type { LogEntry } from "../src/shared/protocol";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocu-smoke-"));
const logs: LogEntry[] = [];
const logger = {
  debug: (m: string, d?: unknown) => logs.push({ seq: logs.length, level: "debug", time: 0, message: m, data: d === undefined ? undefined : JSON.stringify(d) }),
  info: (m: string, d?: unknown) => logs.push({ seq: logs.length, level: "info", time: 0, message: m, data: d === undefined ? undefined : JSON.stringify(d) }),
  warn: (m: string, d?: unknown) => logs.push({ seq: logs.length, level: "warn", time: 0, message: m, data: d === undefined ? undefined : JSON.stringify(d) }),
  error: (m: string, d?: unknown) => logs.push({ seq: logs.length, level: "error", time: 0, message: m, data: d === undefined ? undefined : JSON.stringify(d) }),
};

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const manager = new RuntimeManager({
    logger,
    getSettings: () => ({ runtimeMode: "managed" }),
    startupTimeoutMs: 30_000,
  });
  const adapter = new OpenCodeClientAdapter({
    getBaseUrl: () => manager.getServerUrl(),
    getHeaders: async () => {
      const headers = await manager.getAuthHeaders();
      if (!headers) throw new Error("no auth headers");
      return headers;
    },
    logger,
  });

  try {
    // Subscribe BEFORE connecting: `server.connected` is emitted once at pump start.
    const firstEventPromise = new Promise<string>((resolve) => {
      const sub = adapter.onEvent.subscribe((event) => {
        resolve(event.kind);
        sub.unsubscribe();
      });
      setTimeout(() => resolve("timeout"), 10000);
    });

    console.log("== 1. managed start (real opencode serve) ==");
    await manager.start({ workspaceRoot: scratch });
    check("runtime state is running", manager.getState() === "running", `state=${manager.getState()}`);
    const url = manager.getServerUrl();
    check("server url captured", typeof url === "string" && url.startsWith("http://127.0.0.1:"), url);
    check("pid captured", typeof manager.getMeta().pid === "number");

    console.log("== 2. adapter connect (Basic auth) ==");
    await adapter.connect();
    check("connection state connected", adapter.connection.state === "connected", adapter.connection.state);
    const info = await adapter.serverInfo();
    check("server info version", typeof info?.version === "string" && info.version.length > 0, JSON.stringify(info));

    console.log("== 3. session lifecycle ==");
    const sessions0 = await adapter.listSessions();
    check("listSessions returns array", Array.isArray(sessions0));
    const created = await adapter.createSession({ title: "ocu-smoke" });
    check("createSession returns id", typeof created.id === "string" && created.id.startsWith("ses_"), created.id);
    await adapter.renameSession(created.id, "ocu-smoke-renamed");
    const reopened = await adapter.getSession(created.id);
    check("rename persisted", reopened?.title === "ocu-smoke-renamed", reopened?.title);
    const messages = await adapter.listMessages(created.id);
    check("listMessages empty on new session", Array.isArray(messages) && messages.length === 0);
    const models = await adapter.listModels();
    check("models listed", models.models.length > 0, `${models.models.length} models`);
    check("providers listed", models.providers.length > 0, `${models.providers.length} providers`);
    const agents = await adapter.listAgents();
    check("agents listed", agents.length > 0, `${agents.length} agents`);
    const secretsLeaked = JSON.stringify(models).includes("sk-");
    check("no apiKey leaked in catalog", !secretsLeaked);
    await adapter.deleteSession(created.id);
    const afterDelete = await adapter.getSession(created.id);
    check("session deleted", afterDelete === undefined || afterDelete.id === undefined);

    console.log("== 4. event stream (SSE) ==");
    const firstEvent = await firstEventPromise;
    check("first event received", firstEvent !== "timeout", firstEvent);

    console.log("== 5. redaction in logs ==");
    const logBlob = JSON.stringify(logs);
    check("no sk- keys in logs", !logBlob.includes("sk-"));
    check("no password field in logs", !/"password"\s*:/.test(logBlob));
  } finally {
    await adapter.disconnect();
    await manager.stop();
    check("runtime stopped", manager.getState() === "stopped", manager.getState());
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort
    }
  }

  console.log(failures === 0 ? "\nSMOKE: ALL CHECKS PASSED" : `\nSMOKE: ${failures} CHECK(S) FAILED`);
  if (failures > 0) {
    console.log("--- recent logs ---");
    for (const entry of logs.slice(-15)) console.log(`[${entry.level}] ${entry.message} ${entry.data ?? ""}`);
    process.exitCode = 1;
  }
}

void main();

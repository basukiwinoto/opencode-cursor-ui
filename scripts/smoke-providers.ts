/**
 * Read-only live check: listKeycapableIntegrations + listCredentialSummary
 * against a real OpenCode server. No mutations, no keys printed.
 */
import { spawn } from "node:child_process";
import { OpenCodeClientAdapter } from "../src/opencode/adapter";

async function main(): Promise<void> {
  const proc = spawn("opencode", ["serve", "--port", "14203", "--hostname", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"] });
  let password = "";
  let url = "";
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 20000);
    proc.stdout.on("data", (d) => {
      const s = d.toString();
      const m = s.match(/server listening on (http:\/\/\S+)/);
      const p = s.match(/server password (\S+)/);
      if (m) url = m[1];
      if (p) password = p[1];
      if (url && password) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const adapter = new OpenCodeClientAdapter({
    getBaseUrl: () => url,
    getHeaders: async () => ({ authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") }),
    logger,
  });
  await adapter.connect();
  const integrations = await adapter.listKeycapableIntegrations();
  console.log("key-capable integrations:", integrations.length);
  console.log("sample:", JSON.stringify(integrations.slice(0, 3)));
  const creds = await adapter.listCredentialSummary();
  console.log(
    "credential summary (redacted):",
    JSON.stringify(creds.map((c) => ({ integrationID: c.integrationID, active: c.active, hasKey: c.hasKey }))),
  );
  console.log("anthropic available:", integrations.some((i) => i.id === "anthropic"));
  proc.kill("SIGTERM");
  adapter.disconnect();
  console.log("PROVIDERS-SMOKE OK");
  process.exit(0);
}

void main();

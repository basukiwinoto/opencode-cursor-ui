# Test results

**Date:** 2026-11-20 · **Platform:** macOS (darwin 24.x, arm64) · **OpenCode:** v2.2.6 · **Node:** v22.23.4

## Unit tests — 208 passing (vitest, 16 files, <0.5s)

| Suite | Tests | Covers |
|---|---|---|
| runtime-version | semver parsing/compare, version-token extraction | Phase 2 compatibility checks |
| runtime-platform | OS/arch mapping, npm platform packages, remote detection (ssh/wsl/devcontainer), service registration path | Phase 2 detection |
| runtime-release-verifier | registry metadata validation, SRI integrity, version mismatch, network failure taxonomy | Phase 2 installation integrity |
| runtime-installer | detection priority (custom→PATH→managed), npm-missing error, verification failure, managed update + rollback, external `opencode upgrade` approval hook | Phase 2 install/update |
| runtime-manager | managed start (fake spawn), startup timeout, unexpected exit → reconnecting → exponential backoff, stop lifecycle (SIGTERM→SIGKILL), external discover, password never logged, busy guard | Phase 2 lifecycle |
| runtime-health | healthy→unhealthy transitions, timeout handling, backoff | Phase 2 reconnection |
| opencode-redact | deep apiKey/password scrubbing, `sk-` pattern scrubbing | Phase 7 security |
| opencode-event-normalizer | every consumed V2Event family → normalized events, both payload generations, malformed→null (no throw), permission view mapping | Phase 3 |
| opencode-adapter | connect/401, message mapping (user/assistant/tools/streaming states), prompt with model switch, permission reply, reconnect transitions `connecting→connected→reconnecting→connected`, dispose stops pump | Phase 3 |
| protocol-validation | closed webview message unions, per-type payload shape checks, injection rejection | Phase 7 webview security |
| app-store | streaming text/reasoning accumulation, tool lifecycle by callID, dedup, idle/busy, permission queue/resolve, file changes, session ordering | Phase 4 state |
| redaction | sk- keys, authorization headers, registered secrets, deep redaction, level filtering | Phase 7 logs |
| context-collector | active file, selection with line info, override off, diagnostics counting (vscode mocked) | Phase 5 |
| model-config | default model/agent config-file read/write (JSON merge, backup, malformed-JSON refusal, XDG paths) | in-app config writes |
| provider-config | custom provider registration (id/URL validation, env-key passthrough, merge preservation, backup) | in-app provider setup |
| opencode-adapter.forkSession | session.fork at a message / whole session, payload mapping | fork action |

## Live smoke test — 18/18 checks passed (real OpenCode server, no mocks)

`scripts/smoke-entry.ts` (bundle with esbuild, run with node) exercises the exact production path:

1. **Managed start** — spawns real `opencode serve --hostname 127.0.0.1 --port <free>` → state `running`, URL + PID captured from stdout.
2. **Adapter connect** — Basic auth from captured password → `server.connected`, `server.info()` returns version.
3. **Session lifecycle** — list, create, rename (persisted), messages, model/provider/agent catalogs (verifies **no `apiKey` leaks** into catalog payloads), delete.
4. **Event stream** — SSE event received through the reconnecting pump.
5. **Redaction** — no secrets in logs; clean stop.

This smoke caught and fixed a real production bug: the stdout parser originally stopped at the
`server listening` line — which OpenCode prints **before** `server password` — so the password was
never captured and health checks 401'd. The parser now continues past the URL line.

## Provider/API-key smoke — passed (real server, read-only)

`scripts/smoke-providers.ts` verifies the in-app provider-setup surface against a live server:
330 key-capable integrations listed, redacted credential summary (no key material in output),
`anthropic` connectable. The `integration.connect.key` storage path matches the official SDK
types and the flow OpenCode's own TUI uses.

## Build & packaging

- `tsc --noEmit` (host + webview, strict + `noUncheckedIndexedAccess`): **0 errors**
- `vite build` (webview): clean, `dist/webview/webview.js` + `webview.css`
- `esbuild` (host): clean, `dist/extension.js`
- `vsce package`: `dist/opencode-cursor-ui.vsix` (~401 KB) — installs into VS Code (`basukiwinoto.opencode-cursor-ui` verified installed)
- **Published**: [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=basukiwinoto.opencode-cursor-ui) v0.1.0 (gallery API verified)

## Platform coverage

- **macOS arm64**: fully verified (unit + live smoke + install).
- **Windows / Linux**: implemented (npm.cmd spawning with `shell:true` for `.cmd` shims — extension-generated args only, platform binary packages `opencode-win32-x64` etc., XDG paths) and covered by the same unit suites via injected platform flags, but **not executed on real hardware** in this environment.
- **SSH / WSL / Dev Containers**: remote detection implemented (`vscode.env.remoteName`); runtime runs inside the remote. Not exercised against a live remote here.

## Not yet automated

- Extension Development Host UI interaction (requires a human or playwright-vscode harness; the webview itself is fully typechecked and built).
- Real LLM prompt round-trip (consumes provider credits; permission/tool streaming paths are covered by fixtures from the verified event contract instead).

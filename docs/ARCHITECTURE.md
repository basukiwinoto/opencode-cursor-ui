# Architecture

## Overview

```
┌────────────────────────────────────────────────────────────────────┐
│ VS Code Extension Host                                             │
│                                                                    │
│  extension.ts ── controller.ts (orchestrator)                      │
│      │                    │                                        │
│      │                    ├── commands/          (command palette) │
│      │                    ├── state/appStore.ts  (event aggregator) │
│      │                    ├── webview/           (CSP + routing)   │
│      │                    ├── editor/            (context, diffs)  │
│      │                    ├── runtime/           (lifecycle)       │
│      │                    └── opencode/          (SDK adapter)     │
│  ┌───┴───────────────────────────────────────────────────────┐    │
│  │ Webview (React + Vite bundle, strict CSP)                 │    │
│  │   setup screen · conversation · composer · history ·      │    │
│  │   control center · permissions · file changes             │    │
│  └───────────────────────────────────────────────────────────┘    │
└────────────────────────────┬───────────────────────────────────────┘
                             │ HTTP (loopback) + SSE
                ┌────────────▼─────────────┐
                │ OpenCode server (v2)     │
                │ opencode serve           │
                │ Basic auth: opencode:pw  │
                └──────────────────────────┘
```

## Layers

### 1. Runtime layer (`src/runtime`)

Owns everything between "no OpenCode" and "healthy HTTP endpoint":

- **PlatformResolver** — OS/arch/remote facts (SSH, WSL, devcontainer via `vscode.env.remoteName`),
  npm platform-package mapping. Pure + injectable for tests.
- **ReleaseVerifier** — npm registry metadata (`registry.npmjs.org/opencode`) with SRI integrity
  checks; verifies installed binaries by running `--version` and comparing semver.
- **RuntimeInstaller** — detection (custom path → PATH → managed dir), managed install
  (`npm install opencode@<version> --prefix <managedDir>`; npm verifies tarball integrity against
  registry metadata), updates with rollback, actionable typed errors.
- **RuntimeManager** — lifecycle state machine (`not_installed → installing → stopped → starting →
  running → reconnecting → updating → error`). Managed mode spawns `opencode serve --hostname
  127.0.0.1 --port <free>` in the workspace root, captures the `server password` token from stdout,
  verifies health via authenticated `GET /api/info`, and restarts with backoff on unexpected exit.
  External mode uses the official `@opencode/client` Service discovery or a user-supplied URL.
- **RuntimeHealthMonitor** — periodic authenticated pings with backoff, feeding the reconnect logic.

### 2. Adapter layer (`src/opencode`)

`OpenCodeClientAdapter` wraps `OpenCode.make()` from the official SDK. It is the ONLY module that
knows SDK types. It validates every incoming SSE event with zod (`schemas.ts`), normalizes them into
a UI-friendly union (`eventNormalizer.ts`), redacts secrets (`redact.ts` — model/provider payloads
carry live API keys), and exposes a stable `OpenCodeAdapter` interface (`types.ts`) — sessions,
messages, prompts, permissions, catalogs, diffs, fork, and the credential/integration APIs used for
in-app provider key setup. Config-file writes (default model/agent, custom providers) live in
`modelConfig.ts` / `providerConfig.ts`: JSON-merge only, timestamped backups, malformed configs
never overwritten.

### 3. State layer (`src/state/appStore.ts`)

Aggregates normalized events into canonical per-session message state (streaming text/reasoning,
tool lifecycle keyed by `callID`, permissions, file changes, busy flags). The webview is a view over
snapshots; the host is authoritative. The controller (`src/controller.ts`) wires events → store →
throttled webview pushes.

### 4. Webview (`webview/`, React + Vite)

Cursor-style sidebar: setup screen, **tabbed multi-chat conversation** (one tab per open chat,
"+" to open more), an inline **sessions pane** (search, New Agent, Customize, day-grouped history
with live status icons — split side-by-side with the chat), composer (agent pill + model selector,
@-mentions, attachments, drafts), control center (config/control/logs sections), per-message
**fork & copy** actions (fork uses OpenCode's `session.fork`).
Strict CSP (`script-src 'nonce-…'`, no remote origins), every incoming message validated against
`shared/protocol.ts` on the host, every outgoing message type-checked on both sides.

### 5. Shared protocol (`shared/protocol.ts`)

Single source of truth for the webview↔host boundary, with runtime type guards used by the host to
reject malformed messages before acting on them.

## Security model

- Managed server binds to `127.0.0.1` with a per-process password (Basic auth); the password lives
  only in process memory and is redacted by `RingLogger.registerSecret`.
- Provider API keys are never requested, stored, or displayed by the extension; they stay in the
  user's OpenCode configuration (`opencode auth login`) or environment.
- External-server credentials (optional) go into `vscode.SecretStorage`, never settings.
- Workspace Trust gates all agent execution; untrusted workspaces never auto-start the runtime.
- Webview cannot execute arbitrary commands: messages are validated against a closed union, and no
  message field is ever used as a command.

## Design decisions

- **SDK-first**: every OpenCode interaction goes through `@opencode/client`; the wire contract is
  documented in [OPENCODE-CONTRACT.md](OPENCODE-CONTRACT.md) and verified against a live server.
- **Snapshots, not rollback**: file change review uses pre-edit snapshots and VS Code's native diff;
  the extension never reverts files (no blanket git resets) and never overwrites user edits.
- **Host-authoritative state**: the webview renders snapshots; reconnects and re-opens rebuild state
  from the server (`message.list`, `session.list`).
- **Managed vs external runtime**: first-class modes; the manager refuses to stop processes it did
  not start.

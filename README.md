# OpenCode Cursor UI

A production-quality VS Code extension that reproduces the Cursor-style Agent & Chat sidebar,
powered entirely by [OpenCode](https://opencode.ai). Detects, installs, configures, launches,
supervises, updates, and talks to OpenCode — no terminal required.

![status](https://img.shields.io/badge/status-beta-orange)

## Features

- **Cursor-like sidebar** — streaming assistant replies, markdown with syntax-highlighted code
  blocks, collapsible reasoning ("Thinking briefly") and tool calls, permission approval cards, file change
  summaries with native VS Code diff review.
- **Multi-chat tabs + sessions pane** — run several agent chats at once as tabs (✕ to close, + to
  open, "…" for history), and toggle an inline **sessions sidebar** next to the chat: search, New
  Agent (⌘N), Customize, day-grouped history with live status icons, per-message **fork & copy**
  (fork branches the conversation via OpenCode's `session.fork` and opens it in a new tab).
- **One-click OpenCode setup** — detects existing installs, installs the official npm release into
  an extension-managed directory (with integrity verification), starts/stops/restarts/updates the
  runtime, and reconnects automatically when the server drops.
- **In-app provider setup** — connect a provider's API key through OpenCode's official credential
  API (330+ providers), add custom OpenAI-compatible providers (base URL + key, `env:VAR` passthrough),
  and set OpenCode's global default model/agent (config-file writes with backup, same keys the CLI/TUI read).
- **Real OpenCode integration** — uses the official `@opencode/client` SDK against OpenCode v2
  (`opencode serve` HTTP API). No simulated agents, no mock responses.
- **Sessions** — full chat history from the OpenCode server: resume, rename, delete, drafts that
  survive restarts, model + agent pickers, `@`-mentions and selection/file attachments.
- **Editor integration** — send the current selection or file, attach diagnostics counts, review
  every file the agent touched in VS Code's native diff editor (safe snapshots, no blanket git
  resets, never overwrites your edits).
- **Runtime Control Center** — compact three-section panel: config (server/state/version/provider/
  model/agent with inline change actions), control (start/restart/stop/update/disconnect/select server),
  and redacted diagnostic logs.
- **Security first** — restrictive webview CSP with per-render nonce, validated host↔webview
  messages, server password + provider API keys redacted from logs and never sent to the webview,
  SecretStorage for external-server credentials, workspace-trust gating before any agent execution.

## Install

**From the Marketplace** (VS Code): search "OpenCode Cursor UI" or:
```bash
code --install-extension basukiwinoto.opencode-cursor-ui
```

### From source

```bash
npm install
npm run package          # produces dist/opencode-cursor-ui.vsix
code --install-extension dist/opencode-cursor-ui.vsix
```

### Development

```bash
npm install
npm run build            # typecheck + webview + host bundle
code .                   # then F5 → "Run Extension (Dev Host)"
```

## Usage

1. Open the **OpenCode** view — it lives in the **Secondary Sidebar (right side) by default**
   (toggle with `⌘⌥B` / `Ctrl+Alt+B`). Drag it elsewhere if you prefer; VS Code remembers.
2. If OpenCode isn't installed, the setup screen offers a one-click **Install** (asks for
   confirmation first). Already have OpenCode? The extension detects it on PATH or via
   `opencodeCursorUI.runtime.executablePath`.
3. Pick a **model** and **agent** in the composer. Provider credentials come from your existing
   OpenCode configuration — run `opencode auth login` in a terminal if you haven't yet.
4. Chat. Approve permission requests inline. Review file changes in the Changes section; click a
   file to open the native diff.

All commands live in the Command Palette under the `OpenCode` category:
Open Chat, New Chat, Open Chat History, Install/Start/Stop/Restart/Update OpenCode, Select Model,
**Set Default Model (OpenCode Config)**, **Connect Provider (API Key)**, **Add Custom Provider**,
Select Agent, **Set Default Agent (OpenCode Config)**, Open Runtime Settings, Show Runtime Logs,
Reconnect, Connect to Existing Server, Send Selection.

**Provider setup:** "Connect Provider (API Key)" stores and activates a key through OpenCode's
official credential API (`integration.connect.key`) — the key goes only to the local OpenCode
server and is never logged or rendered. "Add Custom Provider" registers an OpenAI-compatible
provider (id, name, base URL, key, optional model list) in `~/.config/opencode/opencode.json`
via safe JSON merge with a timestamped backup; malformed configs are never overwritten. Keys
accept the `env:VAR_NAME` form so a literal secret never touches disk.

## Configuration

Settings live under the `opencodeCursorUI.*` namespace — see
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full reference.

Key settings:

| Setting | Default | Description |
|---|---|---|
| `opencodeCursorUI.runtime.mode` | `managed` | `managed` = extension supervises a private server; `external` = connect to a running server. |
| `opencodeCursorUI.runtime.autoStart` | `true` | Start/connect when a trusted workspace opens. |
| `opencodeCursorUI.runtime.autoUpdate` | `false` | Auto-update the managed runtime when a new version ships. |
| `opencodeCursorUI.external.serverUrl` | `""` | Server URL for external mode. |
| `opencodeCursorUI.session.restoreLast` | `true` | Reopen the last conversation. |

## Documentation

- [Architecture overview](docs/ARCHITECTURE.md)
- [OpenCode integration contract](docs/OPENCODE-CONTRACT.md) — verified wire-level facts
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Configuration reference](docs/CONFIGURATION.md)
- [Test results](docs/TESTING.md)

## Requirements

- VS Code 1.99+
- Node.js 20+ (for installing from source; the packaged extension bundles its runtime deps)
- OpenCode v2.x (auto-installed if missing; MIT-licensed CLI by Anomaly/SST)

## Known limitations

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md#known-limitations).

## License

MIT

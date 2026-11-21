# Configuration reference

All settings live under the `opencodeCursorUI` namespace. Changes apply without restarting VS Code.

## Runtime

| Setting | Type | Default | Description |
|---|---|---|---|
| `opencodeCursorUI.runtime.mode` | `"managed" \| "external"` | `"managed"` | `managed`: the extension installs and supervises a private OpenCode server per workspace. `external`: connect to an already-running server. |
| `opencodeCursorUI.runtime.executablePath` | `string` | `""` | Explicit path to an OpenCode executable. Empty = auto-detect on PATH, then the managed directory. |
| `opencodeCursorUI.runtime.autoStart` | `boolean` | `true` | Start (managed) or connect (external) when a trusted workspace opens. |
| `opencodeCursorUI.runtime.startupTimeoutMs` | `number` | `30000` | Time to wait for the server to answer authenticated health checks before failing startup. |
| `opencodeCursorUI.runtime.autoUpdate` | `boolean` | `false` | Automatically update the managed runtime when the server announces a new version. Update always restarts the runtime. |
| `opencodeCursorUI.external.serverUrl` | `string` | `""` | Base URL for external mode, e.g. `http://127.0.0.1:4096`. |

### External mode authentication

The OpenCode v2 server requires Basic auth (`opencode:<password>`). For external servers the
extension prompts for the password once and stores it in VS Code **SecretStorage** (never in
settings.json, never in logs). Managed runtimes receive the password automatically from the server's
stdout.

## Sessions & editor

| Setting | Type | Default | Description |
|---|---|---|---|
| `opencodeCursorUI.session.restoreLast` | `boolean` | `true` | Reopen the most recent conversation for the workspace on startup. |
| `opencodeCursorUI.editor.autoIncludeSelection` | `boolean` | `true` | Attach the active file (or selection) as context with each prompt. |
| `opencodeCursorUI.editor.includeDiagnostics` | `boolean` | `true` | Surface error/warning counts from the active editor as context. |

## UI

| Setting | Type | Default | Description |
|---|---|---|---|
| `opencodeCursorUI.ui.showToolCalls` | `boolean` | `true` | Show collapsible tool-call rows in the conversation. |
| `opencodeCursorUI.ui.showFileChanges` | `boolean` | `true` | Show the file-changes section with +/- line counts and diff links. |

## Permissions

| Setting | Type | Default | Description |
|---|---|---|---|
| `opencodeCursorUI.permissions.interactive` | `boolean` | `true` | Surface OpenCode permission requests as approval cards. Disabling forwards decisions to OpenCode's own defaults — the extension never bypasses OpenCode's permission enforcement. |

Approval scopes ("Allow once" / "Always allow") are whatever the server offers per request
(`Permission.Request.save`); the extension only renders the options OpenCode itself provides.

## Diffs

| Setting | Type | Default | Description |
|---|---|---|---|
| `opencodeCursorUI.diff.useNativeDiff` | `boolean` | `true` | Open file changes in VS Code's native diff editor using pre-edit snapshots. When off (or no snapshot exists), the file opens directly. |

## Logging

| Setting | Type | Default | Description |
|---|---|---|---|
| `opencodeCursorUI.log.level` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | Output channel verbosity. Server passwords and API keys are redacted at every level. |

## Default model & agent (OpenCode config writes)

- **Set Default Model (OpenCode Config)** / **Set Default Agent (OpenCode Config)** write OpenCode's
  global defaults to `~/.config/opencode/opencode.json` — key `"model": "providerID/modelID"` and
  `"default_agent": "<id>"`, the same keys the CLI and TUI read.
- Writes are JSON merges (all other keys preserved), a timestamped `.bak-<timestamp>` backup is
  created first, and malformed configs are **never** overwritten.
- API keys accept the `env:VAR_NAME` form for custom providers, so a literal secret never touches disk.

## Provider credentials (in-app)

- **Connect Provider (API Key)** stores and activates a key through OpenCode's official credential
  API (`integration.connect.key`). The key goes only to the local OpenCode server — it is never
  written to the extension's storage, logs, or the webview.
- **Add Custom Provider** registers an OpenAI-compatible provider in the config file:
  `provider.<id>` with `npm: "@ai-sdk/openai-compatible"`, `options.baseURL`, optional
  `options.apiKey` (or `{env:VAR}`), and optional model definitions with context/output limits.

## Managed install location

The managed runtime installs to the extension's global storage:
`<globalStorage>/managed-runtime` (resolves via
`vscode.Uri.joinPath(context.globalStorageUri, "managed-runtime")`). The installed `opencode` binary
is version-pinned by the installer and verified against npm registry metadata before use.

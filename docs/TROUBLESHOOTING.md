# Troubleshooting

## Setup screen says "OpenCode not installed" but I have it

- Check the detected path: **Select server** in the Control Center (managed mode) or the
  `opencodeCursorUI.runtime.executablePath` setting.
- Point the extension at your binary: `opencodeCursorUI.runtime.executablePath` (e.g.
  `/opt/homebrew/bin/opencode` on macOS homebrew, `%LOCALAPPDATA%\Programs\opencode\opencode.exe`
  on Windows).
- The extension requires OpenCode **v2.0.0 or newer** (`opencode --version`). Old v0/v1 builds are
  not compatible with the v2 API used here — update with `opencode upgrade`.

## Install fails

- The managed install uses `npm`. Ensure Node.js/npm are on PATH (the extension tells you when npm
  is missing).
- Corporate proxies: set the standard `HTTPS_PROXY` environment variable before launching VS Code.
- Full error details live in the output channel: Command Palette → **OpenCode: Show Runtime Logs**.

## "Authentication required" / 401 errors

- The OpenCode v2 server requires HTTP Basic auth with the per-process password printed at startup.
  The extension captures it automatically for managed runtimes.
- For **external** servers you must supply the password: use
  **OpenCode: Connect to Existing OpenCode Server** (stored in VS Code SecretStorage), or restart
  your server with the extension's managed mode.
- If you started the server yourself, the password is in its startup output
  (`server password …`).

## Sidebar shows "starting…" forever

- Default startup timeout is 30s (`opencodeCursorUI.runtime.startupTimeoutMs`).
- Check logs for port conflicts — the extension picks a free loopback port automatically, but
  firewalls can still block binds.
- Try **OpenCode: Restart OpenCode**.

## Streaming stops mid-reply

- The event stream auto-reconnects with backoff. If the server died, the runtime indicator turns
  yellow (reconnecting) then red (error). **OpenCode: Reconnect** forces an immediate retry.
- Sessions are preserved server-side; reopening the chat refetches messages.

## Permission requests don't appear

- Ensure `opencodeCursorUI.permissions.interactive` is enabled (default).
- Requests appear as cards in the conversation; they must be answered while the session is active.

## Model list is empty

- Models come from the OpenCode server (`/api/model`). Connect a provider from inside the
  extension (**Control Center → API key**, or Command Palette → *OpenCode: Connect Provider
  (API Key)*), or configure providers with `opencode auth
  login` in a terminal (or set API keys in your OpenCode config), then **OpenCode: Reconnect**.
- The extension never handles provider API keys itself — by design they never leave OpenCode.

## Diffs don't open

- Pre-edit snapshots are captured when the agent's edit tools report their inputs. If the agent
  modified files outside the workspace or before the extension connected, the extension opens the
  file instead of a diff (it refuses to guess a base version).
- Snapshot-based diffs never overwrite your changes; the right side is always the live file.

## Dev Container / SSH / WSL

- The extension detects remote environments via `vscode.env.remoteName`. The OpenCode runtime runs
  in the remote, so install OpenCode inside the remote environment (the setup screen's Install
  action does this in the remote when running in extension host context).

## Diagnostics checklist

1. Command Palette → **OpenCode: Show Runtime Logs**.
2. Control Center → OpenCode Config (state, server URL, version, provider/model/agent) and
   OpenCode Control (**Select server** for the executable path; PID appears in the server tooltip area).
3. `opencode --version` in a terminal.
4. If managed install: check `~/Library/Application Support/Code/User/globalStorage/<publisher>/managed-runtime` (macOS).

## Known limitations

- **Platforms**: automated tests run on macOS (development platform). Windows and Linux paths are
  implemented (npm.cmd shims, platform binary packages, XDG paths) but are not exercised by CI in
  this repository.
- **Rollback**: updates roll back only for managed installs; external installs use the official
  `opencode upgrade` flow.
- **Per-session model switching** uses the prompt-level `model` field; global default model changes
  require OpenCode config.
- **Webview markdown images** are intentionally not loaded (CSP); links open externally.
- The runtime control center polls installation/versions every 60s; very slow registries may delay
  the "update available" chip.

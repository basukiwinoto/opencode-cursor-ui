import * as vscode from "vscode";
import { DisposableStore } from "../core/disposables";
import type { LogEntry } from "../../shared/protocol";
import {
  isWebviewToHost,
  type HostToWebview,
  type UiState,
  type WebviewToHost,
} from "../../shared/protocol";
import type { ExtensionSettings } from "../config/settings";
import type { Log } from "../core/logger";
import type { AppStore } from "../state/appStore";
import type { OpenCodeAdapter } from "../opencode/types";

type ThenableOrPromiseOrVoid = void | Thenable<void> | Promise<void>;

export interface ChatSidebarDeps {
  readonly extensionUri: vscode.Uri;
  readonly adapter: OpenCodeAdapter;
  readonly store: AppStore;
  readonly logger: Log;
  readonly getSettings: () => ExtensionSettings;
  readonly getUiState: () => UiState;
  readonly onCommand: (message: WebviewToHost) => ThenableOrPromiseOrVoid;
  readonly onLogEntry: (listener: (entries: LogEntry[]) => void) => vscode.Disposable;
}

/**
 * Host side of the chat webview. Owns the strict CSP, resource roots and
 * message validation; rendering is delegated to the React app.
 */
export class ChatSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "opencodeCursorUI.chatView";

  private view?: vscode.WebviewView;
  private readonly disposables = new DisposableStore();
  private ready = false;
  private pendingPush: NodeJS.Timeout | undefined;

  constructor(private readonly deps: ChatSidebarDeps) {
    this.disposables.add(
      deps.onLogEntry((entries: LogEntry[]) => {
        this.push({ type: "logAppended", entries });
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, "dist", "webview")],
    };
    view.webview.html = this.buildHtml(view.webview);
    this.disposables.add(
      view.webview.onDidReceiveMessage((raw: unknown) => {
        void this.handleMessage(raw);
      }),
    );
    this.disposables.add(
      view.onDidDispose(() => {
        this.view = undefined;
        this.ready = false;
      }),
    );
  }

  /** Pushes a message to the webview if it is listening. */
  push(message: HostToWebview): void {
    if (!this.view) return;
    void this.view.webview.postMessage(message);
  }

  /** Schedules a full UiState push, coalescing bursts (streaming deltas). */
  scheduleStatePush(): void {
    if (this.pendingPush) return;
    this.pendingPush = setTimeout(() => {
      this.pendingPush = undefined;
      this.push({ type: "state", state: this.deps.getUiState() });
    }, 80);
  }

  pushStateNow(): void {
    if (this.pendingPush) {
      clearTimeout(this.pendingPush);
      this.pendingPush = undefined;
    }
    this.push({ type: "state", state: this.deps.getUiState() });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (!isWebviewToHost(raw)) {
      this.deps.logger.warn("Rejected malformed webview message", {
        type: typeof raw === "object" && raw !== null ? (raw as { type?: unknown }).type : typeof raw,
      });
      return;
    }
    const message: WebviewToHost = raw;
    if (message.type === "ready") {
      this.ready = true;
      this.pushStateNow();
      return;
    }
    try {
      await this.deps.onCommand(message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.logger.error("Command from webview failed", { type: message.type, detail });
      this.push({ type: "error", message: "Command failed", detail });
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const root = vscode.Uri.joinPath(this.deps.extensionUri, "dist", "webview");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, "webview.js"));
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(root, "webview.css"));
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      "connect-src none",
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styles}">
  <title>OpenCode</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.pendingPush) clearTimeout(this.pendingPush);
    this.disposables.dispose();
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

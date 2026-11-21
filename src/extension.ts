import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { readSettings, onSettingsChange, type ExtensionSettings } from "./config/settings";
import { DisposableStore, toDisposable } from "./core/disposables";
import { RingLogger } from "./core/logger";
import { ContextCollector } from "./editor/contextCollector";
import { DiffReviewService } from "./editor/diffReview";
import { FileChangeTracker, SNAPSHOT_SCHEME, SnapshotContentProvider } from "./editor/fileChangeTracker";
import { AppStore } from "./state/appStore";
import { ChatSidebarProvider } from "./webview/chatSidebarProvider";
import {
  ExtensionController,
  describeError,
  setLogSink as setControllerLogSink,
  type InstallerApi,
  type RuntimeControllerApi,
} from "./controller";
import type { HostToWebview, LogEntry, UiState, WebviewToHost } from "../shared/protocol";
import { MIN_OPENCODE_VERSION } from "./runtime/types";
import { RuntimeManager } from "./runtime/runtimeManager";
import { RuntimeInstaller } from "./runtime/runtimeInstaller";
import { OpenCodeClientAdapter } from "./opencode/adapter";

type ThenableOrPromiseOrVoid = void | Thenable<void> | Promise<void>;

/** Bridges controller pushes to the webview provider, which is created later. */
class ProviderBridge {
  private target?: Pick<ChatSidebarProvider, "push" | "pushStateNow" | "scheduleStatePush">;

  attach(target: Pick<ChatSidebarProvider, "push" | "pushStateNow" | "scheduleStatePush">): void {
    this.target = target;
  }

  push(message: HostToWebview): void {
    this.target?.push(message);
  }

  pushStateNow(): void {
    this.target?.pushStateNow();
  }

  scheduleStatePush(): void {
    this.target?.scheduleStatePush();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const disposables = new DisposableStore();
  context.subscriptions.push(disposables);

  const output = vscode.window.createOutputChannel("OpenCode Cursor UI");
  disposables.add(output);
  const logger = new RingLogger(output, 500, readSettings().logLevel);
  setControllerLogSink(() => logger.snapshot());

  const getSettings = (): ExtensionSettings => readSettings();
  const bridge = new ProviderBridge();

  const platform = { remoteName: vscode.env.remoteName };
  const runtime = new RuntimeManager({
    logger,
    getSettings,
    platform,
    getPassword: () =>
      Promise.resolve(context.secrets.get("opencodeCursorUI.externalPassword")).catch(() => undefined),
    shouldStop: () => true,
  });
  const installer = new RuntimeInstaller({
    logger,
    getSettings,
    platform,
    managedBaseDir: vscode.Uri.joinPath(context.globalStorageUri, "managed-runtime").fsPath,
  });
  context.subscriptions.push(
    toDisposable(() => void runtime.dispose()),
  );

  const adapter = new OpenCodeClientAdapter({
    getBaseUrl: () => runtime.getServerUrl(),
    getHeaders: async () => {
      const fromRuntime = await runtime.getAuthHeaders().catch(() => undefined);
      const headers = fromRuntime ?? (await externalAuthHeaders(context));
      if (!headers) {
        throw new Error(
          "No OpenCode credentials available — start the managed runtime (it receives the server password automatically) or connect to an external server with a password.",
        );
      }
      return headers;
    },
    logger,
  });

  const store = new AppStore();
  const collector = new ContextCollector(getSettings);
  const snapshots = new SnapshotContentProvider();
  const tracker = new FileChangeTracker(snapshots, logger);
  const diff = new DiffReviewService(snapshots, getSettings);

  const controller = new ExtensionController(
    { workspaceState: context.workspaceState, secrets: context.secrets, extensionUri: context.extensionUri },
    {
      runtime,
      installer,
      adapter,
      store,
      provider: bridge,
      collector,
      tracker,
      diff,
      logger,
      getSettings,
      minRequiredVersion: MIN_OPENCODE_VERSION,
    },
  );

  const provider = new ChatSidebarProvider({
    extensionUri: context.extensionUri,
    adapter,
    store,
    logger,
    getSettings,
    getUiState: () => controller.buildUiState(),
    onCommand: (message: WebviewToHost) => handleWebviewCommand(controller, message),
    onLogEntry: (listener: (entries: LogEntry[]) => void) => toDisposable(logger.onEntry(listener)),
  });
  bridge.attach(provider);

  disposables.add(
    vscode.Disposable.from(
      vscode.window.registerWebviewViewProvider(ChatSidebarProvider.viewId, provider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, snapshots),
      controller,
      provider,
      tracker,
      registerCommands(controller, () => output.show(true)),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void autoStart(controller, getSettings, logger)),
      vscode.window.onDidChangeActiveTextEditor(() => controller.pushStateNow()),
      vscode.window.onDidChangeTextEditorSelection(() => controller.pushStateNow()),
      onSettingsChange((updated) => {
        logger.setLevel(updated.logLevel);
        logger.info("Settings updated");
        controller.pushStateNow();
      }),
    ),
  );

  logger.info("OpenCode Cursor UI activated");
  void autoStart(controller, getSettings, logger);
}

export function deactivate(): void {
  // Managed runtime disposal happens through DisposableStore teardown.
}

async function externalAuthHeaders(context: vscode.ExtensionContext): Promise<Record<string, string> | undefined> {
  try {
    const stored = await Promise.resolve(context.secrets.get("opencodeCursorUI.externalPassword"));
    if (!stored) return undefined;
    return { authorization: `Basic ${Buffer.from(`opencode:${stored}`).toString("base64")}` };
  } catch {
    return undefined;
  }
}

async function autoStart(
  controller: ExtensionController,
  getSettings: () => ExtensionSettings,
  logger: RingLogger,
): Promise<void> {
  if (!getSettings().autoStart) return;
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) return;
  if (!vscode.workspace.isTrusted) {
    logger.info("Workspace untrusted; skipping auto-start");
    return;
  }
  const status: UiState["runtime"] = controller.buildUiState().runtime;
  if (status.state === "running" || status.state === "starting") return;
  logger.info("Auto-starting OpenCode runtime");
  await controller.startRuntime().catch((error: unknown) => {
    logger.warn("Auto-start failed", describeError(error));
  });
}

function handleWebviewCommand(controller: ExtensionController, message: WebviewToHost): ThenableOrPromiseOrVoid {
  switch (message.type) {
    case "ready":
      return;
    case "sendMessage":
      return controller.sendMessage(message.text, message.files);
    case "stop":
      return controller.interrupt();
    case "newChat":
      return controller.newChat();
    case "openSession":
      return controller.openSession(message.sessionID);
    case "listSessions":
      return controller.openHistory();
    case "renameSession":
      return controller.renameSession(message.sessionID, message.title);
    case "deleteSession":
      return controller.deleteSession(message.sessionID);
    case "forkSession":
      return controller.forkSession(message.sessionID, message.messageID);
    case "requestCatalog":
      return controller.refreshCatalogs();
    case "selectModel":
      return controller.selectModel(message.providerID, message.modelID);
    case "selectAgent":
      return controller.selectAgent(message.agentID);
    case "setDefaultModel":
      return controller.setDefaultModelInteractive();
    case "setDefaultAgent":
      return controller.setDefaultAgentInteractive();
    case "disconnect":
      return controller.disconnectRuntime();
    case "setupProviderKey":
      return controller.setProviderKeyInteractive();
    case "addProvider":
      return controller.addProviderInteractive();
    case "permissionReply":
      return controller.permissionReply(message.requestID, message.sessionID, message.decision);
    case "openDiff":
      return controller.openDiff(message.path);
    case "openFile":
      return controller.openFile(message.path, message.line);
    case "installRuntime":
      return controller.installRuntime();
    case "startRuntime":
      return controller.startRuntime();
    case "stopRuntime":
      return controller.stopRuntime();
    case "restartRuntime":
      return controller.restartRuntime();
    case "updateRuntime":
      return controller.updateRuntime();
    case "reconnect":
      return controller.reconnect();
    case "selectExecutable":
      return controller.selectExecutable();
    case "connectExternal":
      return controller.connectExternal(message.url);
    case "openSettings":
      return vscode.commands.executeCommand("workbench.action.openSettings", "opencodeCursorUI.");
    case "openLogs":
      return vscode.commands.executeCommand("opencodeCursorUI.showRuntimeLogs");
    case "saveDraft":
      return controller.saveDraft(message.sessionID, message.text);
    case "navigate":
      return controller.setView(message.view);
    case "openControlCenter":
      return controller.setView("control");
  }
}

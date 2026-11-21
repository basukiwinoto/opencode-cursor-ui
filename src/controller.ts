import * as vscode from "vscode";
import { DisposableStore, toDisposable } from "./core/disposables";
import type {
  AgentOption,
  FileChangeView,
  InstallProgress,
  LogEntry,
  ModelOption,
  ModelRef,
  ProviderOption,
  RuntimeStatus,
  SessionSummary,
  SetupInfo,
  UiState,
  WebviewToHost,
} from "../shared/protocol";
import type { ExtensionSettings } from "./config/settings";
import type { Log } from "./core/logger";
import type { AppStore } from "./state/appStore";
import type { ChatSidebarProvider } from "./webview/chatSidebarProvider";
import type { ConnectionStatus, NormalizedEvent, OpenCodeAdapter, PermissionDecision } from "./opencode/types";
import type { ContextCollector } from "./editor/contextCollector";
import type { DiffReviewService } from "./editor/diffReview";
import type { FileChangeTracker } from "./editor/fileChangeTracker";
import type { DetectedRuntime } from "./runtime/types";
import { readDefaultAgent, readDefaultModel, writeDefaultAgent, writeDefaultModel } from "./opencode/modelConfig";
import { isValidProviderId, writeCustomProvider } from "./opencode/providerConfig";

/** Structural API the controller needs from the runtime layer. */
export interface RuntimeControllerApi {
  getState(): import("../shared/protocol").RuntimeState;
  onStateChange(listener: (state: import("../shared/protocol").RuntimeState) => void): vscode.Disposable;
  start(workspaceRoot: string): Promise<void>;
  stop(): Promise<void>;
  restart(workspaceRoot: string): Promise<void>;
  connectExternal(config: { url: string; password?: string }): Promise<void>;
  disconnect(): Promise<void>;
  getAuthHeaders(): Promise<Record<string, string>>;
  getServerUrl(): string | undefined;
  getMode(): "managed" | "external";
  getMeta(): { executablePath?: string; pid?: number; serverUrl?: string };
}

export interface InstallerApi {
  detect(): Promise<DetectedRuntime>;
  install(options: { version?: string; onProgress?: (progress: InstallProgress) => void }): Promise<{ executablePath: string; version?: string }>;
  update(request: {
    executablePath: string;
    toVersion?: string;
    onProgress?: (progress: InstallProgress) => void;
    healthCheck?: () => Promise<void>;
    approveUpgrade?: () => Promise<boolean>;
  }): Promise<{ executablePath: string; version?: string; status?: "updated" | "manual"; instruction?: string }>;
  latestVersion(): Promise<string | undefined>;
}

const DRAFTS_KEY = "opencodeCursorUI.drafts";
const LAST_SESSION_KEY = "opencodeCursorUI.lastSession";
const SELECTED_MODEL_KEY = "opencodeCursorUI.selectedModel";
const SELECTED_AGENT_KEY = "opencodeCursorUI.selectedAgent";
const EXTERNAL_PASSWORD_KEY = "opencodeCursorUI.externalPassword";

/**
 * Orchestrates runtime lifecycle, the adapter event flow, and every webview
 * command. This is the extension's brain; UI and SDK stay thin.
 */
export class ExtensionController implements vscode.Disposable {
  private view: UiState["view"] = "chat";
  private activeSessionID?: string;
  private models: ModelOption[] = [];
  private providers: ProviderOption[] = [];
  private agents: AgentOption[] = [];
  private selectedModel?: ModelRef;
  private selectedAgent?: string;
  private configDefaultModel?: ModelRef;
  private configDefaultAgent?: string;
  private drafts: Record<string, string> = {};
  private installProgress?: InstallProgress;
  private cachedSetup?: SetupInfo;
  private latestRelease?: string;
  private readonly disposables = new DisposableStore();
  private refreshTimer?: NodeJS.Timeout;
  private lastDiffSession?: string;

  constructor(
    private readonly context: {
      workspaceState: vscode.Memento;
      secrets: vscode.SecretStorage;
      extensionUri: vscode.Uri;
    },
    private readonly deps: {
      runtime: RuntimeControllerApi;
      installer: InstallerApi;
      adapter: OpenCodeAdapter;
      store: AppStore;
      provider: Pick<ChatSidebarProvider, "push" | "pushStateNow" | "scheduleStatePush">;
      collector: ContextCollector;
      tracker: FileChangeTracker;
      diff: DiffReviewService;
      logger: Log;
      getSettings: () => ExtensionSettings;
      minRequiredVersion: string;
    },
  ) {
    this.drafts = context.workspaceState.get<Record<string, string>>(DRAFTS_KEY, {});
    const savedModel = context.workspaceState.get<ModelRef>(SELECTED_MODEL_KEY);
    if (savedModel) this.selectedModel = savedModel;
    const savedAgent = context.workspaceState.get<string>(SELECTED_AGENT_KEY);
    if (savedAgent) this.selectedAgent = savedAgent;

    const eventSub = deps.adapter.onEvent.subscribe((event) => this.applyEvent(event));
    const connectionSub = deps.adapter.onConnectionChange.subscribe(() => this.pushStateNow());
    const stateSub = deps.runtime.onStateChange(() => {
      void this.refreshCatalogs();
      this.pushStateNow();
    });
    this.disposables.add(
      vscode.Disposable.from(
        toDisposable(() => eventSub.unsubscribe()),
        toDisposable(() => connectionSub.unsubscribe()),
        stateSub,
      ),
    );
    void this.refreshSetup();
    this.refreshTimer = setInterval(() => void this.refreshSetup(), 60_000);
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.disposables.dispose();
  }

  // -- events ---------------------------------------------------------------

  private readonly toolNamesByCall = new Map<string, string>();

  private applyEvent(event: NormalizedEvent): void {
    if (event.kind === "tool.started") {
      this.toolNamesByCall.set(event.callID, event.tool);
      if (this.toolNamesByCall.size > 500) {
        const first = this.toolNamesByCall.keys().next().value;
        if (first !== undefined) this.toolNamesByCall.delete(first);
      }
    }
    if (event.kind === "update.available") {
      this.latestRelease = event.version;
      if (this.deps.getSettings().autoUpdate && this.deps.runtime.getMode() === "managed") {
        void this.updateRuntime(false);
      }
      return;
    }
    if (event.kind === "server.shutdown") {
      this.deps.logger.warn("OpenCode server reported shutdown");
      return;
    }
    if (event.kind === "tool.started" || event.kind === "tool.input") {
      void this.capturePreEditFromEvent(event);
    }
    if (event.kind === "tool.completed") {
      const call = event;
      if (call.status === "success") void this.refreshFileChanges(call.sessionID);
    }
    if (event.kind === "session.idle") {
      void this.refreshFileChanges(event.sessionID);
      this.saveLastSession(event.sessionID);
    }

    this.deps.store.applyEvent(event);

    const sessionID =
      "sessionID" in event ? event.sessionID : "session" in event && event.session ? event.session.id : undefined;
    if (sessionID && sessionID === this.activeSessionID) {
      if (event.kind === "message.started" || event.kind === "message.updated") {
        this.deps.provider.push({ type: "messageUpserted", sessionID, message: event.message });
        if (event.kind === "message.started") {
          this.deps.provider.scheduleStatePush();
        }
        return;
      }
      const message = findTouchedMessage(this.deps.store, sessionID, event);
      if (message) {
        this.deps.provider.push({ type: "messageUpserted", sessionID, message });
      }
      if (event.kind === "permission.asked") {
        this.deps.provider.push({ type: "permissionAsked", request: event.request });
      }
      if (event.kind === "permission.replied") {
        this.deps.provider.push({ type: "permissionResolved", requestID: event.requestID, decision: event.decision });
      }
    }
    if (event.kind === "session.updated" || event.kind === "session.deleted") {
      this.deps.provider.scheduleStatePush();
    }
    if (event.kind === "file.changed") {
      this.deps.provider.scheduleStatePush();
    }
  }

  private async capturePreEditFromEvent(event: NormalizedEvent): Promise<void> {
    if (event.kind === "tool.input") {
      const tool = this.toolNamesByCall.get(event.callID) ?? "edit";
      await this.deps.tracker.capturePreEdit(tool, event.input);
    }
  }

  private async refreshFileChanges(sessionID: string): Promise<void> {
    try {
      const diffs = await this.deps.adapter.sessionDiff(sessionID);
      this.deps.store.setFileChanges(sessionID, diffs);
      this.deps.provider.push({ type: "fileChangesUpdated", changes: this.deps.store.getFileChanges() });
    } catch (error) {
      this.deps.logger.debug("sessionDiff unavailable", describeError(error));
    }
  }

  // -- setup / runtime ------------------------------------------------------

  async refreshSetup(): Promise<void> {
    try {
      const detected = await this.deps.installer.detect();
      this.latestRelease = this.latestRelease ?? (await this.deps.installer.latestVersion().catch(() => undefined));
      this.cachedSetup = {
        installed: detected.installed,
        version: detected.version,
        minRequiredVersion: this.deps.minRequiredVersion,
        latestVersion: this.latestRelease,
        executablePath: detected.executablePath,
        platform: this.currentPlatform(),
        detection: detected.method === "custom" ? "custom" : detected.method === "managed" ? "managed" : detected.installed ? "path" : "none",
        compatError: detected.compatError,
      };
    } catch (error) {
      this.deps.logger.warn("Setup detection failed", describeError(error));
    }
  }

  private currentPlatform() {
    return {
      os: process.platform,
      arch: process.arch,
      remote: null as string | null,
      isRemote: false,
    };
  }

  runtimeStatus(): RuntimeStatus {
    const state = this.deps.runtime.getState();
    const meta = this.deps.runtime.getMeta();
    const connection: ConnectionStatus = this.deps.adapter.connection;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const status: RuntimeStatus = {
      state,
      mode: this.deps.runtime.getMode(),
      version: this.cachedSetup?.version,
      latestVersion: this.latestRelease,
      updateAvailable:
        this.latestRelease !== undefined &&
        this.cachedSetup?.version !== undefined &&
        this.latestRelease !== this.cachedSetup.version,
      executablePath: meta.executablePath ?? this.cachedSetup?.executablePath,
      serverUrl: meta.serverUrl ?? connection.serverUrl,
      workspaceRoot: root,
      pid: meta.pid,
    };
    if (connection.state === "connected" && state === "running") return status;
    if (connection.error && (state === "error" || state === "stopped")) {
      status.error = connection.error;
    }
    return status;
  }

  async installRuntime(): Promise<void> {
    const approval = await vscode.window.showWarningMessage(
      "Install OpenCode? The extension will download the official npm package into its managed directory.",
      { modal: true },
      "Install",
    );
    if (approval !== "Install") return;
    try {
      this.installProgress = { phase: "checking", message: "Resolving release…" };
      this.pushStateNow();
      const result = await this.deps.installer.install({
        onProgress: (progress) => {
          this.installProgress = progress;
          this.deps.provider.push({ type: "installProgress", progress });
        },
      });
      this.installProgress = { phase: "done", message: `Installed at ${result.executablePath}` };
      this.deps.provider.push({ type: "installProgress", progress: this.installProgress });
      await this.refreshSetup();
      await this.startRuntime();
    } catch (error) {
      this.installProgress = { phase: "error", message: describeError(error) };
      this.deps.provider.push({ type: "installProgress", progress: this.installProgress });
      this.deps.logger.error("Install failed", describeError(error));
      void vscode.window.showErrorMessage(`OpenCode installation failed: ${describeError(error)}`);
    } finally {
      this.pushStateNow();
    }
  }

  async startRuntime(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      void vscode.window.showErrorMessage("Open a workspace folder before starting OpenCode.");
      return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage("OpenCode does not start in untrusted workspaces.");
      return;
    }
    try {
      if (this.deps.getSettings().runtimeMode === "external") {
        await this.connectExternal();
      } else {
        await this.deps.runtime.start(root);
      }
      await this.deps.adapter.connect();
      await this.refreshCatalogs();
      await this.restoreOrActivateSession();
      this.view = "chat";
      // The view lives in the Secondary Sidebar by default — surface it on start.
      await Promise.resolve(vscode.commands.executeCommand("opencodeCursorUI.chatView.focus")).catch(() => undefined);
      this.pushStateNow();
    } catch (error) {
      this.deps.logger.error("Start failed", describeError(error));
      void vscode.window.showErrorMessage(`Failed to start OpenCode: ${describeError(error)}`);
      this.pushStateNow();
    }
  }

  async stopRuntime(): Promise<void> {
    if (this.deps.store.isBusy()) {
      const proceed = await vscode.window.showWarningMessage(
        "An agent task is still running. Stop the runtime anyway?",
        { modal: true },
        "Stop",
      );
      if (proceed !== "Stop") return;
    }
    try {
      await this.deps.adapter.disconnect();
      await this.deps.runtime.stop();
    } catch (error) {
      this.deps.logger.error("Stop failed", describeError(error));
    }
    this.pushStateNow();
  }

  async restartRuntime(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    try {
      await this.deps.adapter.disconnect();
      await this.deps.runtime.restart(root);
      await this.deps.adapter.connect();
      await this.refreshCatalogs();
    } catch (error) {
      this.deps.logger.error("Restart failed", describeError(error));
    }
    this.pushStateNow();
  }

  async updateRuntime(confirm = true): Promise<void> {
    if (confirm) {
      const proceed = await vscode.window.showInformationMessage(
        `Update OpenCode${this.latestRelease ? ` to ${this.latestRelease}` : ""}? The runtime will restart.`,
        { modal: true },
        "Update",
      );
      if (proceed !== "Update") return;
    }
    try {
      this.installProgress = { phase: "downloading", message: "Updating OpenCode…" };
      this.pushStateNow();
      const executable = this.runtimeStatus().executablePath;
      if (!executable) throw new Error("No OpenCode executable detected");
      const result = await this.deps.installer.update({
        executablePath: executable,
        onProgress: (progress) => {
          this.installProgress = progress;
          this.deps.provider.push({ type: "installProgress", progress });
        },
        approveUpgrade: async () => {
          const approval = await vscode.window.showWarningMessage(
            "Update OpenCode using `opencode upgrade`? This runs the official CLI updater.",
            { modal: true },
            "Update",
          );
          return approval === "Update";
        },
      });
      if (result.status === "manual") {
        this.installProgress = { phase: "error", message: result.instruction ?? "Manual update required" };
        void vscode.window.showInformationMessage(result.instruction ?? "Update manually with `opencode upgrade`.");
      } else {
        this.installProgress = { phase: "done", message: `Updated${result.version ? ` to ${result.version}` : ""}` };
      }
      await this.refreshSetup();
      if (this.deps.runtime.getState() === "running") {
        await this.restartRuntime();
      }
    } catch (error) {
      this.installProgress = { phase: "error", message: describeError(error) };
      this.deps.logger.error("Update failed", describeError(error));
      void vscode.window.showErrorMessage(`Update failed: ${describeError(error)}`);
    } finally {
      this.pushStateNow();
    }
  }

  async reconnect(): Promise<void> {
    try {
      await this.deps.adapter.connect();
      await this.refreshCatalogs();
    } catch (error) {
      this.deps.logger.warn("Reconnect failed", describeError(error));
    }
    this.pushStateNow();
  }

  async connectExternal(urlInput?: string): Promise<void> {
    let url = urlInput ?? this.deps.getSettings().externalServerUrl;
    if (!url) {
      url =
        (await vscode.window.showInputBox({
          prompt: "External OpenCode server URL",
          placeHolder: "http://127.0.0.1:4096",
          ignoreFocusOut: true,
        })) ?? "";
    }
    if (!url) return;
    const stored = await Promise.resolve(this.context.secrets.get(EXTERNAL_PASSWORD_KEY)).catch(() => undefined);
    await this.deps.runtime.connectExternal({ url, password: stored });
    await this.deps.adapter.connect();
    await this.refreshCatalogs();
    this.pushStateNow();
  }

  async selectExecutable(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: "Select the OpenCode executable",
    });
    const file = picked?.[0];
    if (!file) return;
    const configuration = vscode.workspace.getConfiguration("opencodeCursorUI");
    await configuration.update("runtime.executablePath", file.fsPath, vscode.ConfigurationTarget.Global);
    await this.refreshSetup();
    this.pushStateNow();
  }

  // -- chat / sessions ------------------------------------------------------

  async restoreOrActivateSession(): Promise<void> {
    if (this.activeSessionID && this.deps.store.getSession(this.activeSessionID)) {
      await this.openSession(this.activeSessionID);
      return;
    }
    const saved = this.context.workspaceState.get<string>(this.lastSessionKey());
    if (saved && this.deps.getSettings().restoreLastSession) {
      const session = await this.deps.adapter.getSession(saved).catch(() => undefined);
      if (session) {
        await this.openSession(saved);
        return;
      }
    }
    await this.newChat();
  }

  async newChat(): Promise<void> {
    try {
      const session = await this.deps.adapter.createSession({
        title: suggestedTitle(),
        agentID: this.selectedAgent,
      });
      this.deps.store.upsertSession(session);
      this.deps.store.setMessages(session.id, []);
      await this.openSession(session.id);
    } catch (error) {
      this.deps.logger.error("New chat failed", describeError(error));
      void vscode.window.showErrorMessage(`Could not create a chat: ${describeError(error)}`);
    }
  }

  async openSession(sessionID: string): Promise<void> {
    try {
      const messages = await this.deps.adapter.listMessages(sessionID);
      this.deps.store.setMessages(sessionID, messages);
      this.activeSessionID = sessionID;
      this.saveLastSession(sessionID);
      this.view = "chat";
      await this.refreshCatalogs(false);
      this.pushStateNow();
    } catch (error) {
      this.deps.logger.error("Open session failed", describeError(error));
      void vscode.window.showErrorMessage(`Could not open chat: ${describeError(error)}`);
    }
  }

  async openHistory(): Promise<void> {
    try {
      const sessions = await this.deps.adapter.listSessions();
      for (const session of sessions) this.deps.store.upsertSession(session);
      this.view = "history";
      this.pushStateNow();
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not load history: ${describeError(error)}`);
    }
  }

  async renameSession(sessionID: string, title: string): Promise<void> {
    await this.deps.adapter.renameSession(sessionID, title.trim());
    const session = this.deps.store.getSession(sessionID);
    if (session) this.deps.store.upsertSession({ ...session, title: title.trim() });
    this.pushStateNow();
  }

  async deleteSession(sessionID: string): Promise<void> {
    try {
      await this.deps.adapter.deleteSession(sessionID);
    } catch (error) {
      this.deps.logger.warn("Delete failed", describeError(error));
    }
    this.deps.store.removeSession(sessionID);
    if (this.activeSessionID === sessionID) {
      this.activeSessionID = undefined;
      await this.newChat();
    } else {
      this.pushStateNow();
    }
  }

  /** Branches the conversation at a message and opens the fork as a new tab. */
  async forkSession(sessionID: string, beforeMessageID?: string): Promise<void> {
    try {
      const forked = await this.deps.adapter.forkSession(sessionID, beforeMessageID);
      this.deps.store.upsertSession(forked);
      await this.openSession(forked.id);
      void vscode.window.showInformationMessage(
        `Forked conversation${forked.title ? `: ${forked.title}` : ""}. It opened in a new tab.`,
      );
    } catch (error) {
      const message = describeError(error);
      this.deps.logger.error("Fork failed", message);
      void vscode.window.showErrorMessage(`Could not fork the conversation: ${message}`);
    }
  }

  async sendMessage(text: string, files?: Array<{ uri: string; name?: string }>): Promise<void> {
    if (!text.trim()) return;
    if (this.deps.runtime.getState() !== "running") {
      void vscode.window.showInformationMessage("OpenCode is not running. Start it from the sidebar setup screen.");
      return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage("Agent execution is disabled in untrusted workspaces.");
      return;
    }
    let sessionID = this.activeSessionID;
    if (!sessionID) {
      await this.newChat();
      sessionID = this.activeSessionID;
    }
    if (!sessionID) return;

    const collected = this.deps.collector.collect();
    const mergedFiles = [...(files ?? []), ...collected.promptAttachments];
    try {
      // Optimistic user message for instant feedback.
      const optimistic: import("../shared/protocol").ChatMessage = {
        id: `local-${Date.now()}`,
        role: "user",
        text,
        tools: [],
        attachments: mergedFiles.map((f) => ({
          name: f.name ?? f.uri.split("/").pop() ?? f.uri,
          uri: f.uri,
          kind: "file",
        })),
        createdAt: Date.now(),
        streaming: false,
      };
      const list = this.deps.store.getMessages(sessionID);
      list.push(optimistic);
      this.deps.provider.push({ type: "messageUpserted", sessionID, message: optimistic });
      this.clearDraft(sessionID);

      await this.deps.adapter.prompt({
        sessionID,
        text,
        files: mergedFiles.length > 0 ? mergedFiles : undefined,
        agentID: this.selectedAgent,
        model: this.selectedModel,
      });
    } catch (error) {
      const message = describeError(error);
      this.deps.logger.error("Prompt failed", message);
      this.deps.provider.push({ type: "error", message: "Failed to send prompt", detail: message });
    }
  }

  async interrupt(): Promise<void> {
    const sessionID = this.activeSessionID;
    if (!sessionID) return;
    try {
      await this.deps.adapter.interrupt(sessionID);
    } catch (error) {
      this.deps.logger.warn("Interrupt failed", describeError(error));
    }
  }

  async permissionReply(requestID: string, sessionID: string, decision: PermissionDecision): Promise<void> {
    try {
      await this.deps.adapter.replyPermission(sessionID, requestID, decision);
      const resolved = this.deps.store.resolvePermission(requestID);
      if (resolved) {
        this.deps.provider.push({ type: "permissionResolved", requestID, decision });
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Permission reply failed: ${describeError(error)}`);
    }
  }

  /** Guides the user through storing a provider API key via the official connect API. */
  async setProviderKeyInteractive(): Promise<void> {
    if (this.deps.runtime.getState() !== "running") {
      void vscode.window.showInformationMessage("Start OpenCode first — credentials are stored by the OpenCode server.");
      return;
    }
    let integrations: Array<{ id: string; name: string; connected: boolean }> = [];
    try {
      integrations = await this.deps.adapter.listKeycapableIntegrations();
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not load provider list: ${describeError(error)}`);
      return;
    }
    if (integrations.length === 0) {
      void vscode.window.showWarningMessage("No key-capable providers are available from the OpenCode server.");
      return;
    }
    const sorted = [...integrations].sort((a, b) => Number(b.connected) - Number(a.connected) || a.id.localeCompare(b.id));
    const picked = await vscode.window.showQuickPick(
      sorted.map((it) => ({
        label: `${it.connected ? "$(check) " : ""}${it.name}`,
        description: it.id,
        integration: it,
      })),
      { title: "Connect a provider — enter its API key", matchOnDescription: true },
    );
    if (!picked) return;

    const key = await vscode.window.showInputBox({
      prompt: `API key for "${picked.integration.name}" (${picked.integration.id})`,
      password: true,
      ignoreFocusOut: true,
      placeHolder: "Paste the API key — it is sent to the local OpenCode server only",
      validateInput: (value) => (value.trim().length === 0 ? "API key must not be empty" : undefined),
    });
    if (key === undefined) return;

    try {
      await this.deps.adapter.setProviderKey(picked.integration.id, key);
      const label = picked.integration.connected ? "updated" : "stored";
      void vscode.window.showInformationMessage(`API key ${label} for ${picked.integration.name} (${picked.integration.id}).`);
      this.deps.logger.info(`Provider key ${label} for integration`, picked.integration.id);
      await this.refreshCatalogs();
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not store the API key: ${describeError(error)}`);
      this.deps.logger.error("Provider key storage failed", describeError(error));
    }
  }

  /** Adds an OpenAI-compatible custom provider to OpenCode's config file. */
  async addProviderInteractive(): Promise<void> {
    const id = await vscode.window.showInputBox({
      prompt: "Provider id (used as the provider prefix, e.g. \"my-proxy\")",
      placeHolder: "my-proxy",
      ignoreFocusOut: true,
      validateInput: (value) => (isValidProviderId(value) ? undefined : "Letters, digits, dashes only (max 64 chars)"),
    });
    if (id === undefined) return;

    const name = await vscode.window.showInputBox({
      prompt: "Display name",
      placeHolder: "My Proxy",
      ignoreFocusOut: true,
      value: id,
    });
    if (name === undefined || name.trim().length === 0) return;

    const baseURL = await vscode.window.showInputBox({
      prompt: "Base URL (OpenAI-compatible endpoint)",
      placeHolder: "https://api.example.com/v1",
      ignoreFocusOut: true,
      validateInput: (value) => (/^https?:\/\//.test(value.trim()) ? undefined : "Must be an http(s) URL"),
    });
    if (baseURL === undefined) return;

    const apiKey = await vscode.window.showInputBox({
      prompt: 'API key — paste it, or enter "env:VAR_NAME" to reference an environment variable',
      password: true,
      ignoreFocusOut: true,
    });
    if (apiKey === undefined) return;

    const modelsInput = await vscode.window.showInputBox({
      prompt: "Model ids to register (comma-separated, optional — e.g. \"gpt-4o, gpt-4o-mini\")",
      placeHolder: "gpt-4o, gpt-4o-mini",
      ignoreFocusOut: true,
    });
    if (modelsInput === undefined) return;

    const models = modelsInput
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m.length > 0)
      .map((m) => ({ id: m, name: m }));

    const result = await writeCustomProvider({
      id,
      name: name.trim(),
      baseURL: baseURL.trim(),
      apiKey: apiKey.trim().length > 0 ? apiKey.trim() : undefined,
      models,
    });
    if (!result.ok) {
      void vscode.window.showErrorMessage(`Could not add provider: ${result.error}`);
      this.deps.logger.error("Add provider failed", result.error);
      return;
    }
    this.deps.logger.info("Custom provider added to OpenCode config", { id, baseURL: baseURL.trim() });
    const reload = await vscode.window.showInformationMessage(
      `Provider "${id}" added to the OpenCode config.${result.backupPath ? " Backup created." : ""} Restart the runtime to pick it up?`,
      "Restart",
      "Later",
    );
    if (reload === "Restart") {
      await this.restartRuntime();
    } else {
      await this.refreshCatalogs();
    }
  }

  /** Writes OpenCode's global default agent (config file, same key the CLI/TUI use). */
  async setDefaultAgentInteractive(): Promise<void> {
    if (this.agents.length === 0) await this.refreshCatalogs(false);
    const picked = await vscode.window.showQuickPick(
      this.agents.map((agent) => ({ label: agent.name, description: agent.description ?? agent.id, agent })),
      { title: "Set OpenCode Default Agent (global config)" },
    );
    if (!picked) return;
    const result = await writeDefaultAgent(picked.agent.id);
    if (!result.ok) {
      void vscode.window.showErrorMessage(`Could not set default agent: ${result.error}`);
      return;
    }
    this.configDefaultAgent = picked.agent.id;
    this.deps.logger.info("OpenCode default agent updated", { agent: picked.agent.id, backup: result.backupPath });
    void vscode.window.showInformationMessage(
      `OpenCode default agent set to "${picked.agent.id}".${result.backupPath ? " Backup created." : ""}`,
    );
    this.pushStateNow();
  }

  /** Disconnects from the OpenCode server without stopping a managed process. */
  async disconnectRuntime(): Promise<void> {
    try {
      await this.deps.adapter.disconnect();
      await this.deps.runtime.disconnect();
    } catch (error) {
      this.deps.logger.warn("Disconnect failed", describeError(error));
    }
    this.pushStateNow();
  }

  // -- catalog --------------------------------------------------------------

  async refreshCatalogs(push = true): Promise<void> {
    try {
      const catalog = await this.deps.adapter.listModels();
      this.models = catalog.models;
      this.providers = catalog.providers;
      this.agents = await this.deps.adapter.listAgents();
      this.configDefaultModel = await readDefaultModel().catch(() => undefined);
      this.configDefaultAgent = await readDefaultAgent().catch(() => undefined);
      if (!this.selectedModel && catalog.defaultModel) {
        this.selectedModel = {
          providerID: catalog.defaultModel.providerID,
          modelID: catalog.defaultModel.modelID,
        };
        await this.context.workspaceState.update(SELECTED_MODEL_KEY, this.selectedModel);
      }
    } catch (error) {
      this.deps.logger.debug("Catalog refresh failed", describeError(error));
    }
    if (push) this.pushStateNow();
  }

  async selectModelInteractive(): Promise<void> {
    if (this.models.length === 0) await this.refreshCatalogs(false);
    const picks = this.models.map((model) => ({
      label: model.label,
      description: `${model.providerID} · ${model.modelID}`,
      model,
    }));
    const picked = await vscode.window.showQuickPick(picks, {
      title: "Select OpenCode Model",
      matchOnDescription: true,
    });
    if (!picked) return;
    await this.selectModel(picked.model.providerID, picked.model.modelID);
  }

  async selectModel(providerID: string, modelID: string): Promise<void> {
    this.selectedModel = { providerID, modelID };
    await this.context.workspaceState.update(SELECTED_MODEL_KEY, this.selectedModel);
    this.pushStateNow();
  }

  async selectAgent(agentID: string): Promise<void> {
    this.selectedAgent = agentID;
    await this.context.workspaceState.update(SELECTED_AGENT_KEY, agentID);
    this.pushStateNow();
  }

  async selectAgentInteractive(): Promise<void> {
    if (this.agents.length === 0) await this.refreshCatalogs(false);
    const picked = await vscode.window.showQuickPick(
      this.agents.map((agent) => ({ label: agent.name, description: agent.description, agent })),
      { title: "Select OpenCode Agent" },
    );
    if (picked) await this.selectAgent(picked.agent.id);
  }

  /** Writes OpenCode's global default model (config file, same key the CLI/TUI use). */
  async setDefaultModelInteractive(): Promise<void> {
    if (this.models.length === 0) await this.refreshCatalogs(false);
    const picks = this.models.map((model) => ({
      label: model.label,
      description: `${model.providerID} · ${model.modelID}`,
      model,
    }));
    const picked = await vscode.window.showQuickPick(picks, {
      title: "Set OpenCode Default Model (global config)",
      matchOnDescription: true,
    });
    if (!picked) return;

    const current = this.configDefaultModel
      ? `${this.configDefaultModel.providerID}/${this.configDefaultModel.modelID}`
      : "(OpenCode server default)";
    const approval = await vscode.window.showWarningMessage(
      `Set OpenCode's default model to "${picked.model.providerID}/${picked.model.modelID}"? Current: ${current}. This updates the OpenCode config file (a backup is created first).`,
      { modal: true },
      "Set Default",
    );
    if (approval !== "Set Default") return;

    const result = await writeDefaultModel({
      providerID: picked.model.providerID,
      modelID: picked.model.modelID,
    });
    if (!result.ok) {
      void vscode.window.showErrorMessage(`Could not set default model: ${result.error}`);
      this.deps.logger.error("Set default model failed", result.error);
      return;
    }
    this.configDefaultModel = { providerID: picked.model.providerID, modelID: picked.model.modelID };
    this.deps.logger.info("OpenCode default model updated", {
      model: `${picked.model.providerID}/${picked.model.modelID}`,
      backup: result.backupPath,
    });
    void vscode.window.showInformationMessage(
      `OpenCode default model set to ${picked.model.providerID}/${picked.model.modelID}.${result.backupPath ? ` Backup: ${result.backupPath}` : ""}`,
    );
    this.pushStateNow();
  }

  // -- editor ---------------------------------------------------------------

  async openDiff(path: string, line?: number): Promise<void> {
    await this.deps.diff.open(path, line);
  }

  async openFile(path: string, line?: number): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      const selection =
        line !== undefined ? new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0) : undefined;
      await vscode.window.showTextDocument(document, { preview: true, selection });
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not open file: ${describeError(error)}`);
    }
  }

  async sendSelection(): Promise<void> {
    const collected = this.deps.collector.collect(true);
    const selection = collected.editorContext?.selection;
    if (!selection) {
      void vscode.window.showInformationMessage("Select some code first.");
      return;
    }
    await this.sendMessage(
      `Please look at this code from ${selection.name} (line ${selection.startLine}):\n\n\`\`\`\n${selection.text}\n\`\`\``,
    );
  }

  // -- drafts / state -------------------------------------------------------

  saveDraft(sessionID: string | null, text: string): void {
    const key = sessionID ?? "__new__";
    if (text) this.drafts[key] = text;
    else delete this.drafts[key];
    void this.context.workspaceState.update(DRAFTS_KEY, this.drafts);
  }

  clearDraft(sessionID: string): void {
    delete this.drafts[sessionID];
    void this.context.workspaceState.update(DRAFTS_KEY, this.drafts);
  }

  getDrafts(): Record<string, string> {
    return this.drafts;
  }

  setView(view: UiState["view"]): void {
    this.view = view;
    if (view === "history") void this.openHistory();
    else this.pushStateNow();
  }

  async saveExternalPassword(password: string): Promise<void> {
    await this.context.secrets.store(EXTERNAL_PASSWORD_KEY, password);
    this.deps.logger.info("External server credential stored");
  }

  buildUiState(): UiState {
    const settings = this.deps.getSettings();
    const runtime = this.runtimeStatus();
    const state = this.deps.store.buildUiState({
      view: runtime.state === "not_installed" && this.view !== "control" ? "setup" : this.view,
      runtime,
      setup: this.cachedSetup,
      installProgress: this.installProgress,
      activeSessionID: this.activeSessionID,
      drafts: this.drafts,
      models: this.models,
      providers: this.providers,
      agents: this.agents,
      selectedModel: this.selectedModel,
      selectedAgent: this.selectedAgent,
      configDefaultModel: this.configDefaultModel,
      configDefaultAgent: this.configDefaultAgent,
      showToolCalls: settings.showToolCalls,
      showFileChanges: settings.showFileChanges,
      logs: this.logs(),
      editorContext: this.deps.collector.collect(false).editorContext,
      connection: this.deps.adapter.connection,
    });
    return state;
  }

  logs(): LogEntry[] {
    return logSink();
  }

  private saveLastSession(sessionID: string): void {
    void this.context.workspaceState.update(this.lastSessionKey(), sessionID);
  }

  private lastSessionKey(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "global";
    return `${LAST_SESSION_KEY}:${root}`;
  }

  pushStateNow(): void {
    this.deps.provider.pushStateNow();
  }
}

// Module-level log sink bridge; wired by extension.ts at activation.
let logSinkImpl: () => LogEntry[] = () => [];
export function setLogSink(sink: () => LogEntry[]): void {
  logSinkImpl = sink;
}
function logSink(): LogEntry[] {
  return logSinkImpl();
}

function findTouchedMessage(store: AppStore, sessionID: string, event: NormalizedEvent) {
  if (event.kind === "text.started" || event.kind === "text.delta" || event.kind === "text.ended") {
    return store.getMessages(sessionID).find((m) => m.id === event.messageID);
  }
  if (event.kind === "reasoning.started" || event.kind === "reasoning.delta" || event.kind === "reasoning.ended") {
    return store.getMessages(sessionID).find((m) => m.id === event.messageID);
  }
  if (
    event.kind === "tool.started" || event.kind === "tool.input" || event.kind === "tool.progress" || event.kind === "tool.completed"
  ) {
    return store.getMessages(sessionID).find((m) => m.tools.some((t) => t.callID === event.callID));
  }
  return undefined;
}

function suggestedTitle(): string {
  const now = new Date();
  return `Chat ${now.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

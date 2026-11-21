/**
 * Shared protocol between the extension host and the OpenCode Cursor UI webview.
 *
 * This file is the single source of truth for every message that crosses the
 * webview boundary. Both sides import from here; the host validates every
 * incoming message against `WebviewToHost` before acting on it.
 *
 * Never put secrets in any message. The host redacts before sending.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type RuntimeState =
  | "not_installed"
  | "installing"
  | "stopped"
  | "starting"
  | "running"
  | "reconnecting"
  | "updating"
  | "error";

export type RuntimeMode = "managed" | "external";

export interface PlatformInfo {
  os: string;
  arch: string;
  /** vscode.env.remoteName, when connected to a remote (ssh, wsl, devcontainer, codespaces). */
  remote: string | null;
  isRemote: boolean;
}

export interface RuntimeStatus {
  state: RuntimeState;
  mode: RuntimeMode;
  version?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  executablePath?: string;
  serverUrl?: string;
  workspaceRoot?: string;
  pid?: number;
  error?: string;
  detail?: string;
}

export interface ModelRef {
  providerID: string;
  modelID: string;
  variant?: string;
}

export interface ModelOption {
  providerID: string;
  modelID: string;
  label: string;
  family?: string;
  type?: string;
}

export interface ProviderOption {
  id: string;
  name: string;
  activation?: string;
  modelCount: number;
}

export interface AgentOption {
  id: string;
  name: string;
  description?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: ModelRef;
  agent?: string;
  busy?: boolean;
  cost?: number;
}

export interface ToolCallView {
  callID: string;
  tool: string;
  title?: string;
  status: "pending" | "running" | "success" | "error";
  input?: unknown;
  output?: string;
  error?: string;
  file?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface AttachmentView {
  name: string;
  uri: string;
  kind: "file" | "selection" | "folder" | "diagnostics";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  tools: ToolCallView[];
  attachments: AttachmentView[];
  createdAt: number;
  updatedAt?: number;
  model?: ModelRef;
  cost?: number;
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  streaming: boolean;
  outcome?: "succeeded" | "failed" | "interrupted";
  error?: string;
}

export interface PermissionRequestView {
  requestID: string;
  sessionID: string;
  action: string;
  title: string;
  message?: string;
  resources: string[];
  /** Scopes OpenCode itself offers for persistent approval, e.g. ["once","always"]. */
  saveScopes: string[];
  metadata?: unknown;
  askedAt: number;
}

export interface FileChangeView {
  path: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  patch?: string;
  sessionID?: string;
  reviewed?: boolean;
}

export interface SetupInfo {
  installed: boolean;
  version?: string;
  minRequiredVersion: string;
  latestVersion?: string;
  executablePath?: string;
  managedExecutablePath?: string;
  platform: PlatformInfo;
  detection: "path" | "custom" | "managed" | "none";
  compatError?: string;
  installHint?: string;
}

export interface ControlCenterInfo {
  runtime: RuntimeStatus;
  install: SetupInfo;
  serverUrl?: string;
  activeSession?: SessionSummary;
  model?: ModelRef;
  agentID?: string;
  logs: LogEntry[];
}

export interface LogEntry {
  seq: number;
  level: "debug" | "info" | "warn" | "error";
  time: number;
  message: string;
  data?: string;
}

export interface InstallProgress {
  phase: "checking" | "downloading" | "verifying" | "extracting" | "linking" | "done" | "error";
  message: string;
  percent?: number;
}

export interface UiState {
  view: "chat" | "history" | "setup" | "control";
  runtime: RuntimeStatus;
  setup?: SetupInfo;
  installProgress?: InstallProgress;
  sessions: SessionSummary[];
  activeSessionID?: string;
  messages: ChatMessage[];
  drafts: Record<string, string>;
  models: ModelOption[];
  providers: ProviderOption[];
  agents: AgentOption[];
  selectedModel?: ModelRef;
  selectedAgent?: string;
  /** OpenCode's own configured default model (~/.config/opencode/opencode.json → "model"). */
  configDefaultModel?: ModelRef;
  /** OpenCode's configured default agent (~/.config/opencode/opencode.json → "default_agent"). */
  configDefaultAgent?: string;
  busySessions: Record<string, boolean>;
  fileChanges: FileChangeView[];
  permissions: PermissionRequestView[];
  showToolCalls: boolean;
  showFileChanges: boolean;
  canStop: boolean;
  logs: LogEntry[];
  editorContext?: EditorContext;
}

export interface EditorContext {
  activeFile?: { path: string; name: string };
  selection?: { path: string; name: string; text: string; startLine: number };
  diagnosticCount?: number;
}

// ---------------------------------------------------------------------------
// Webview -> Host
// ---------------------------------------------------------------------------

export interface FileAttachmentInput {
  uri: string;
  name?: string;
}

export type WebviewToHost =
  | { type: "ready" }
  | { type: "sendMessage"; text: string; files?: FileAttachmentInput[] }
  | { type: "stop"; sessionID?: string }
  | { type: "newChat" }
  | { type: "openSession"; sessionID: string }
  | { type: "listSessions" }
  | { type: "renameSession"; sessionID: string; title: string }
  | { type: "deleteSession"; sessionID: string }
  | { type: "forkSession"; sessionID: string; messageID?: string }
  | { type: "requestCatalog" }
  | { type: "selectModel"; providerID: string; modelID: string }
  | { type: "selectAgent"; agentID: string }
  | { type: "setDefaultModel" }
  | { type: "setDefaultAgent" }
  | { type: "disconnect" }
  | { type: "setupProviderKey" }
  | { type: "addProvider" }
  | { type: "permissionReply"; requestID: string; sessionID: string; decision: "once" | "always" | "reject" }
  | { type: "openDiff"; path: string }
  | { type: "openFile"; path: string; line?: number }
  | { type: "installRuntime" }
  | { type: "startRuntime" }
  | { type: "stopRuntime" }
  | { type: "restartRuntime" }
  | { type: "updateRuntime" }
  | { type: "reconnect" }
  | { type: "selectExecutable" }
  | { type: "connectExternal"; url?: string }
  | { type: "openSettings" }
  | { type: "openLogs" }
  | { type: "saveDraft"; sessionID: string | null; text: string }
  | { type: "navigate"; view: UiState["view"] }
  | { type: "openControlCenter" };

export function isWebviewToHost(value: unknown): value is WebviewToHost {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") return false;
  const known = new Set<string>([
    "ready", "sendMessage", "stop", "newChat", "openSession", "listSessions",
    "renameSession", "deleteSession", "forkSession", "requestCatalog", "selectModel", "selectAgent",
    "setDefaultModel", "setDefaultAgent", "disconnect", "setupProviderKey", "addProvider", "permissionReply", "openDiff", "openFile", "installRuntime", "startRuntime",
    "stopRuntime", "restartRuntime", "updateRuntime", "reconnect", "selectExecutable",
    "connectExternal", "openSettings", "openLogs", "saveDraft", "navigate", "openControlCenter",
  ]);
  if (!known.has(type)) return false;
  // Minimal per-type payload shape validation.
  switch (type) {
    case "sendMessage": {
      const m = value as { text?: unknown };
      return typeof m.text === "string";
    }
    case "openSession":
    case "deleteSession":
    case "installRuntime":
    case "startRuntime":
    case "stopRuntime":
    case "restartRuntime":
    case "updateRuntime":
    case "reconnect": {
      const m = value as { sessionID?: unknown };
      return m.sessionID === undefined || typeof m.sessionID === "string";
    }
    case "renameSession": {
      const m = value as { sessionID?: unknown; title?: unknown };
      return typeof m.sessionID === "string" && typeof m.title === "string";
    }
    case "forkSession": {
      const m = value as { sessionID?: unknown; messageID?: unknown };
      return typeof m.sessionID === "string" && (m.messageID === undefined || typeof m.messageID === "string");
    }
    case "selectModel": {
      const m = value as { providerID?: unknown; modelID?: unknown };
      return typeof m.providerID === "string" && typeof m.modelID === "string";
    }
    case "selectAgent": {
      const m = value as { agentID?: unknown };
      return typeof m.agentID === "string";
    }
    case "permissionReply": {
      const m = value as { requestID?: unknown; sessionID?: unknown; decision?: unknown };
      return (
        typeof m.requestID === "string" &&
        typeof m.sessionID === "string" &&
        (m.decision === "once" || m.decision === "always" || m.decision === "reject")
      );
    }
    case "openDiff": {
      const m = value as { path?: unknown };
      return typeof m.path === "string";
    }
    case "openFile": {
      const m = value as { path?: unknown; line?: unknown };
      return typeof m.path === "string" && (m.line === undefined || typeof m.line === "number");
    }
    case "connectExternal": {
      const m = value as { url?: unknown };
      return m.url === undefined || (typeof m.url === "string" && m.url.startsWith("http"));
    }
    case "saveDraft": {
      const m = value as { sessionID?: unknown; text?: unknown };
      return (typeof m.sessionID === "string" || m.sessionID === null) && typeof m.text === "string";
    }
    case "navigate": {
      const m = value as { view?: unknown };
      return m.view === "chat" || m.view === "history" || m.view === "setup" || m.view === "control";
    }
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Host -> Webview
// ---------------------------------------------------------------------------

export type HostToWebview =
  | { type: "state"; state: UiState }
  | { type: "patch"; state: Partial<UiState> }
  | { type: "messageUpserted"; sessionID: string; message: ChatMessage }
  | { type: "permissionAsked"; request: PermissionRequestView }
  | { type: "permissionResolved"; requestID: string; decision: string }
  | { type: "fileChangesUpdated"; changes: FileChangeView[] }
  | { type: "installProgress"; progress: InstallProgress }
  | { type: "logAppended"; entries: LogEntry[] }
  | { type: "error"; message: string; detail?: string }
  | { type: "info"; message: string };

export function isHostToWebview(value: unknown): value is HostToWebview {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "state" || type === "patch" || type === "messageUpserted" ||
    type === "permissionAsked" || type === "permissionResolved" ||
    type === "fileChangesUpdated" || type === "installProgress" ||
    type === "logAppended" || type === "error" || type === "info"
  );
}

export const PROTOCOL_VERSION = 1;

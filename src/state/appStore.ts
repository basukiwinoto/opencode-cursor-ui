import type {
  ChatMessage,
  FileChangeView,
  PermissionRequestView,
  SessionSummary,
  ToolCallView,
  UiState,
} from "../../shared/protocol";
import type { ConnectionStatus, NormalizedEvent } from "../opencode/types";

/**
 * Host-side aggregator. Consumes normalized OpenCode events and maintains
 * canonical per-session message state, permissions, file changes and catalogs.
 * The webview receives snapshots from here — it holds no authoritative state.
 */
export class AppStore {
  private readonly sessions = new Map<string, SessionSummary>();
  private readonly messages = new Map<string, ChatMessage[]>();
  private readonly permissions = new Map<string, PermissionRequestView>();
  private readonly fileChanges = new Map<string, FileChangeView>();
  private readonly busy = new Map<string, boolean>();
  private messageOrder = new Map<string, Set<string>>();

  upsertSession(session: SessionSummary): void {
    this.sessions.set(session.id, session);
  }

  removeSession(sessionID: string): void {
    this.sessions.delete(sessionID);
    this.messages.delete(sessionID);
    this.busy.delete(sessionID);
    for (const [key, change] of this.fileChanges) {
      if (change.sessionID === sessionID) this.fileChanges.delete(key);
    }
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSession(sessionID: string): SessionSummary | undefined {
    return this.sessions.get(sessionID);
  }

  setMessages(sessionID: string, list: ChatMessage[]): void {
    this.messages.set(sessionID, list);
    this.messageOrder.set(sessionID, new Set(list.map((m) => m.id)));
  }

  getMessages(sessionID: string): ChatMessage[] {
    return this.messages.get(sessionID) ?? [];
  }

  isSessionKnown(sessionID: string): boolean {
    return this.messageOrder.has(sessionID) || this.sessions.has(sessionID);
  }

  applyEvent(event: NormalizedEvent, now = Date.now()): NormalizedEvent[] {
    const followUps: NormalizedEvent[] = [];
    switch (event.kind) {
      case "session.updated": {
        this.upsertSession(event.session);
        break;
      }
      case "session.deleted": {
        this.removeSession(event.sessionID);
        break;
      }
      case "message.started": {
        const list = this.messages.get(event.sessionID) ?? [];
        const index = list.findIndex((m) => m.id === event.message.id);
        if (index >= 0) list[index] = event.message;
        else list.push(event.message);
        this.messages.set(event.sessionID, list);
        this.busy.set(event.sessionID, event.message.role === "assistant");
        break;
      }
      case "message.updated": {
        const list = this.messages.get(event.sessionID) ?? [];
        const index = list.findIndex((m) => m.id === event.message.id);
        if (index >= 0) list[index] = event.message;
        else list.push(event.message);
        this.messages.set(event.sessionID, list);
        break;
      }
      case "text.started":
      case "reasoning.started": {
        this.ensureAssistantMessage(event.sessionID, event.messageID, now);
        this.busy.set(event.sessionID, true);
        break;
      }
      case "text.delta": {
        const message = this.ensureAssistantMessage(event.sessionID, event.messageID, now);
        message.text += event.delta;
        message.updatedAt = now;
        this.busy.set(event.sessionID, true);
        break;
      }
      case "text.ended": {
        const message = this.ensureAssistantMessage(event.sessionID, event.messageID, now);
        if (event.text !== undefined) message.text = event.text;
        message.updatedAt = now;
        break;
      }
      case "reasoning.delta": {
        const message = this.ensureAssistantMessage(event.sessionID, event.messageID, now);
        message.reasoning = (message.reasoning ?? "") + event.delta;
        message.updatedAt = now;
        break;
      }
      case "reasoning.ended": {
        const message = this.ensureAssistantMessage(event.sessionID, event.messageID, now);
        if (event.text !== undefined) message.reasoning = event.text;
        message.updatedAt = now;
        break;
      }
      case "tool.started": {
        const message = this.ensureAssistantMessage(event.sessionID, event.messageID, now);
        if (!message.tools.some((t) => t.callID === event.callID)) {
          message.tools.push({
            callID: event.callID,
            tool: event.tool,
            title: event.title,
            status: "running",
            startedAt: now,
          });
          message.updatedAt = now;
        }
        break;
      }
      case "tool.input": {
        const call = this.findTool(event.sessionID, event.callID);
        if (call) {
          call.input = event.input;
          if (!call.file) {
            const path = extractPathFromInput(event.input);
            if (path) call.file = path;
          }
        }
        break;
      }
      case "tool.progress": {
        const call = this.findTool(event.sessionID, event.callID);
        if (call) call.output = event.output ?? call.output;
        break;
      }
      case "tool.completed": {
        const call = this.findTool(event.sessionID, event.callID);
        if (call) {
          call.status = event.status;
          call.output = event.output ?? call.output;
          call.error = event.error;
          call.finishedAt = now;
        }
        break;
      }
      case "session.idle": {
        this.busy.set(event.sessionID, false);
        const list = this.messages.get(event.sessionID) ?? [];
        for (const message of list) {
          if (message.streaming) {
            message.streaming = false;
            message.updatedAt = now;
          }
        }
        break;
      }
      case "session.retry": {
        this.busy.set(event.sessionID, true);
        break;
      }
      case "session.busy": {
        this.busy.set(event.sessionID, event.busy);
        break;
      }
      case "permission.asked": {
        this.permissions.set(event.request.requestID, event.request);
        this.busy.set(event.request.sessionID, true);
        break;
      }
      case "permission.replied": {
        this.permissions.delete(event.requestID);
        break;
      }
      case "file.changed": {
        // Actual counts are refreshed via sessionDiff by the caller; mark dirty.
        const key = `${event.file}`;
        const existing = this.fileChanges.get(key);
        this.fileChanges.set(key, {
          path: event.file,
          status: event.change === "add" ? "added" : event.change === "unlink" ? "deleted" : existing?.status ?? "modified",
          additions: existing?.additions ?? 0,
          deletions: existing?.deletions ?? 0,
          sessionID: existing?.sessionID,
        });
        break;
      }
      default:
        break;
    }
    return followUps;
  }

  setFileChanges(sessionID: string, changes: Array<{ file: string; patch: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" }>): void {
    for (const change of changes) {
      this.fileChanges.set(`${sessionID}:${change.file}`, {
        path: change.file,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        patch: change.patch,
        sessionID,
      });
    }
  }

  getFileChanges(): FileChangeView[] {
    return [...this.fileChanges.values()];
  }

  clearFileChanges(sessionID?: string): void {
    for (const key of [...this.fileChanges.keys()]) {
      if (sessionID === undefined || this.fileChanges.get(key)?.sessionID === sessionID) {
        this.fileChanges.delete(key);
      }
    }
  }

  listPermissions(): PermissionRequestView[] {
    return [...this.permissions.values()].sort((a, b) => a.askedAt - b.askedAt);
  }

  resolvePermission(requestID: string): PermissionRequestView | undefined {
    const request = this.permissions.get(requestID);
    this.permissions.delete(requestID);
    return request;
  }

  isBusy(sessionID?: string): boolean {
    if (sessionID) return this.busy.get(sessionID) === true;
    return [...this.busy.values()].some(Boolean);
  }

  busyMap(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [key, value] of this.busy) {
      if (value) out[key] = true;
    }
    return out;
  }

  private findTool(sessionID: string, callID: string): ToolCallView | undefined {
    for (const message of this.messages.get(sessionID) ?? []) {
      const call = message.tools.find((t) => t.callID === callID);
      if (call) return call;
    }
    return undefined;
  }

  private ensureAssistantMessage(sessionID: string, messageID: string | undefined, now: number): ChatMessage {
    const list = this.messages.get(sessionID) ?? [];
    let message = messageID !== undefined ? list.find((m) => m.id === messageID) : undefined;
    if (!message) {
      // Events without a message id attach to the most recent assistant message.
      if (messageID === undefined) {
        for (let i = list.length - 1; i >= 0; i--) {
          const candidate = list[i];
          if (candidate && candidate.role === "assistant") {
            message = candidate;
            break;
          }
        }
      }
      if (!message) {
        message = {
          id: messageID ?? `assistant-${sessionID}-${now}`,
          role: "assistant",
          text: "",
          tools: [],
          attachments: [],
          createdAt: now,
          streaming: true,
        };
        list.push(message);
        this.messages.set(sessionID, list);
      }
    }
    message.streaming = true;
    return message;
  }

  buildUiState(options: {
    view: UiState["view"];
    runtime: UiState["runtime"];
    setup?: UiState["setup"];
    installProgress?: UiState["installProgress"];
    activeSessionID?: string;
    drafts: Record<string, string>;
    models: UiState["models"];
    providers: UiState["providers"];
    agents: UiState["agents"];
    selectedModel?: UiState["selectedModel"];
    selectedAgent?: string;
    configDefaultModel?: UiState["configDefaultModel"];
    configDefaultAgent?: UiState["configDefaultAgent"];
    showToolCalls: boolean;
    showFileChanges: boolean;
    logs: UiState["logs"];
    editorContext?: UiState["editorContext"];
    connection: ConnectionStatus;
  }): UiState {
    const active = options.activeSessionID ?? undefined;
    return {
      view: options.view,
      runtime: options.runtime,
      setup: options.setup,
      installProgress: options.installProgress,
      sessions: this.listSessions(),
      activeSessionID: active,
      messages: active ? this.getMessages(active) : [],
      drafts: options.drafts,
      models: options.models,
      providers: options.providers,
      agents: options.agents,
      selectedModel: options.selectedModel,
      selectedAgent: options.selectedAgent,
      configDefaultModel: options.configDefaultModel,
      configDefaultAgent: options.configDefaultAgent,
      busySessions: this.busyMap(),
      fileChanges: this.getFileChanges(),
      permissions: this.listPermissions(),
      showToolCalls: options.showToolCalls,
      showFileChanges: options.showFileChanges,
      canStop: active ? this.isBusy(active) : this.isBusy(),
      logs: options.logs,
      editorContext: options.editorContext,
    };
  }
}

function extractPathFromInput(input: unknown): string | undefined {
  if (typeof input === "string") {
    const match = input.match(/(?:^|\s)([\w./~-]+\.[A-Za-z0-9]{1,6})\b/);
    return match?.[1];
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = extractPathFromInput(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    for (const key of ["file", "path", "filePath", "target", "notebook"]) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
    for (const value of Object.values(record)) {
      const found = extractPathFromInput(value);
      if (found) return found;
    }
  }
  return undefined;
}

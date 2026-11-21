import type {
  AgentOption,
  ChatMessage,
  ModelOption,
  PermissionRequestView,
  ProviderOption,
  SessionSummary,
} from "../../shared/protocol";

export type ConnectionStatus = {
  state: "disconnected" | "connecting" | "connected" | "reconnecting";
  serverUrl?: string;
  error?: string;
};

export type PermissionDecision = "once" | "always" | "reject";

export interface PromptAttachment {
  uri: string;
  name?: string;
}

export interface PromptRequest {
  sessionID: string;
  text: string;
  files?: PromptAttachment[];
  agentID?: string;
  model?: { providerID: string; modelID: string; variant?: string };
}

/** Normalized events derived from OpenCode's V2Event stream. */
export type NormalizedEvent =
  | { kind: "text.started"; sessionID: string; messageID: string }
  | { kind: "text.delta"; sessionID: string; messageID: string; delta: string }
  | { kind: "text.ended"; sessionID: string; messageID: string; text?: string }
  | { kind: "reasoning.started"; sessionID: string; messageID: string }
  | { kind: "reasoning.delta"; sessionID: string; messageID: string; delta: string }
  | { kind: "reasoning.ended"; sessionID: string; messageID: string; text?: string }
  | { kind: "message.started"; sessionID: string; message: ChatMessage }
  | { kind: "message.updated"; sessionID: string; message: ChatMessage }
  | { kind: "tool.started"; sessionID: string; callID: string; tool: string; title?: string; messageID?: string }
  | { kind: "tool.input"; sessionID: string; callID: string; input: unknown }
  | { kind: "tool.progress"; sessionID: string; callID: string; output?: string }
  | {
      kind: "tool.completed";
      sessionID: string;
      callID: string;
      status: "success" | "error";
      output?: string;
      error?: string;
      metadata?: unknown;
    }
  | { kind: "session.updated"; session: SessionSummary }
  | { kind: "session.deleted"; sessionID: string }
  | { kind: "session.idle"; sessionID: string; outcome?: "succeeded" | "failed" | "interrupted"; error?: string }
  | { kind: "session.retry"; sessionID: string; attempt: number; message: string }
  | { kind: "session.busy"; sessionID: string; busy: boolean }
  | { kind: "permission.asked"; request: PermissionRequestView }
  | { kind: "permission.replied"; sessionID: string; requestID: string; decision: PermissionDecision }
  | { kind: "file.changed"; file: string; change: "add" | "change" | "unlink" }
  | { kind: "update.available"; version: string }
  | { kind: "server.shutdown" }
  | { kind: "unknown"; type: string };

/**
 * Adapter isolating the OpenCode SDK from the rest of the extension.
 * Implementations must validate untrusted payloads and never surface secrets.
 */
export interface OpenCodeAdapter extends vscode.DisposableLike {
  readonly connection: ConnectionStatus;
  onConnectionChange: { subscribe(listener: (status: ConnectionStatus) => void): { unsubscribe(): void } };
  onEvent: { subscribe(listener: (event: NormalizedEvent) => void): { unsubscribe(): void } };

  connect(): Promise<void>;
  disconnect(): void;

  serverInfo(): Promise<{ version: string; pid?: number } | undefined>;
  listSessions(): Promise<SessionSummary[]>;
  createSession(init?: { title?: string; agentID?: string }): Promise<SessionSummary>;
  getSession(sessionID: string): Promise<SessionSummary | undefined>;
  renameSession(sessionID: string, title: string): Promise<void>;
  deleteSession(sessionID: string): Promise<void>;
  listMessages(sessionID: string): Promise<ChatMessage[]>;
  prompt(request: PromptRequest): Promise<void>;
  interrupt(sessionID: string): Promise<void>;
  replyPermission(sessionID: string, requestID: string, decision: PermissionDecision, message?: string): Promise<void>;
  /** Branches the conversation: returns a new session containing history before `beforeMessageID` (whole session when omitted). */
  forkSession(sessionID: string, beforeMessageID?: string): Promise<SessionSummary>;
  listPendingPermissions(): Promise<PermissionRequestView[]>;
  listAgents(): Promise<AgentOption[]>;
  listModels(): Promise<{ models: ModelOption[]; providers: ProviderOption[]; defaultModel?: { providerID: string; modelID: string } }>;
  /** Integration ids that accept an API key (models.dev providers + custom). */
  listKeycapableIntegrations(): Promise<Array<{ id: string; name: string; connected: boolean }>>;
  /** Stores and activates an API key for an integration via the official connect API. */
  setProviderKey(integrationID: string, key: string, label?: string): Promise<void>;
  /** Redacted credential overview — never includes key material. */
  listCredentialSummary(): Promise<Array<{ integrationID: string; label: string; active: boolean; hasKey: boolean }>>;
  sessionDiff(sessionID: string): Promise<Array<{ file: string; patch: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" }>>;
}

/** Minimal structural type so this file stays importable without `vscode`. */
export declare namespace vscode {
  interface DisposableLike {
    dispose(): void;
  }
}

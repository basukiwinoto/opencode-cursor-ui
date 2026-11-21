/**
 * Adapter isolating the OpenCode SDK (`@opencode/client`) from the UI layer.
 *
 * - Every SDK response is validated with the tolerant zod schemas in
 *   `./schemas` before it reaches callers.
 * - Model/provider payloads and permission metadata pass through
 *   `./redact` so provider API keys never leave this module.
 * - The event pump reconnects with exponential backoff (1s → 30s, unbounded
 *   retries while the adapter is alive) and reports every connection change.
 * - The server password only ever lives inside the headers produced by the
 *   injected `getHeaders` callback; it is never logged or exposed.
 */

import { OpenCode } from "@opencode/client";
import { z } from "zod";
import type {
  AgentListInput,
  EventSubscribeInput,
  MessageListInput,
  ModelDefaultInput,
  ModelListInput,
  PermissionReplyInput,
  PermissionRequestListInput,
  ProviderListInput,
  SessionCreateInput,
  SessionDiffInput,
  SessionGetInput,
  SessionInterruptInput,
  SessionListInput,
  SessionPromptInput,
  SessionRemoveInput,
  SessionForkInput,
  SessionSwitchModelInput,
  SessionUpdateInput,
} from "@opencode/client";
import type {
  AgentOption,
  AttachmentView,
  ChatMessage,
  ModelOption,
  PermissionRequestView,
  ProviderOption,
  SessionSummary,
  ToolCallView,
} from "../../shared/protocol";
import type { Log } from "../core/logger";
import {
  errorText,
  parseJsonish,
  permissionViewFromSdk,
  sessionSummaryFromInfo,
  toolOutputText,
} from "./eventNormalizer";
import { redactSdkPayload, sanitizeModelOption, sanitizeProviderOption } from "./redact";
import {
  agentInfoSchema,
  assistantMessageSchema,
  fileDiffListSchema,
  flattenEvents,
  listResponseSchema,
  messagesResponseSchema,
  modelInfoSchema,
  parseV2Event,
  providerInfoSchema,
  serverInfoSchema,
  sessionInfoSchema,
  toolPartSchema,
  userMessageSchema,
} from "./schemas";
import type { ConnectionStatus, NormalizedEvent, OpenCodeAdapter, PermissionDecision, PromptRequest } from "./types";

/** Options accepted by the real SDK's per-call request options. */
export interface SdkRequestOptions {
  readonly signal?: AbortSignal;
  readonly headers?: RequestInit["headers"];
  readonly onActivity?: () => void;
}

/** Options accepted by `OpenCode.make`. */
export interface SdkClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly headers?: RequestInit["headers"];
}

/**
 * Structural subset of the SDK client used by this adapter. Tests inject a
 * hand-written fake; the production factory returns the real client, which is
 * structurally compatible.
 */
export interface OpenCodeClientLike {
  server: {
    info(requestOptions?: SdkRequestOptions): Promise<unknown>;
  };
  session: {
    list(input?: SessionListInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
    create(input?: SessionCreateInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
    get(input: SessionGetInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
    update(input: SessionUpdateInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
    remove(input: SessionRemoveInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
    fork(input: SessionForkInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
    prompt(input: SessionPromptInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
    interrupt(input: SessionInterruptInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
    switchModel(input: SessionSwitchModelInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
    diff(input: SessionDiffInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
  };
  message: {
    list(input: MessageListInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
  };
  agent: {
    list(input?: AgentListInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
  };
  provider: {
    list(input?: ProviderListInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
  };
  model: {
    list(input?: ModelListInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
    default(input?: ModelDefaultInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
  };
  permission: {
    request: {
      list(input?: PermissionRequestListInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
    };
    reply(input: PermissionReplyInput, requestOptions?: SdkRequestOptions): Promise<unknown>;
  };
  event: {
    subscribe(input?: EventSubscribeInput, requestOptions?: SdkRequestOptions): AsyncIterable<unknown>;
  };
  integration: {
    list(input?: unknown, requestOptions?: SdkRequestOptions): Promise<unknown>;
    connect: {
      key(input: { integrationID: string; key: string; label?: string }, requestOptions?: SdkRequestOptions): Promise<unknown>;
    };
  };
  credential: {
    list(requestOptions?: SdkRequestOptions): Promise<unknown>;
  };
}

export interface OpenCodeAdapterOptions {
  /** Static server URL. Required unless `getBaseUrl` is provided. */
  baseUrl?: string;
  /**
   * Dynamic server URL resolution, evaluated on every connect(). Use when the
   * runtime allocates its port at start time (managed mode).
   */
  getBaseUrl?: () => string | undefined;
  /** Supplies the Basic-auth headers; the server password never passes through the adapter. */
  getHeaders: () => Promise<Record<string, string>>;
  logger: Log;
  fetchFn?: typeof fetch;
  /** Overridable for tests; defaults to `OpenCode.make`. */
  clientFactory?: (options: SdkClientOptions) => OpenCodeClientLike;
  /** External abort signal (e.g. runtime shutdown) that tears down the event pump. */
  eventSignal?: AbortSignal;
  /** Reconnect backoff tuning; defaults to 1s initial, 30s max, unbounded retries. */
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number };
}

/** Error surfaced by the adapter; preserves the SDK's `_tag` when present. */
export class OpenCodeAdapterError extends Error {
  readonly operation: string;
  readonly tag?: string;

  constructor(operation: string, message: string, options?: { tag?: string; cause?: unknown }) {
    super(message);
    this.name = "OpenCodeAdapterError";
    this.operation = operation;
    if (options?.tag !== undefined) this.tag = options.tag;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

const ACTIONABLE_MESSAGES: Record<string, string> = {
  UnauthorizedError: "authentication failed: check server password",
  ForbiddenError: "access denied by the OpenCode server",
  SessionBusyError: "session is busy — wait for the current run to finish or interrupt it",
  SessionNotFoundError: "session not found",
  MessageNotFoundError: "message not found",
  ModelNotFoundError: "model not found — refresh the model list",
  ProviderNotFoundError: "provider not found",
  InvalidRequestError: "invalid request",
  ServiceUnavailableError: "OpenCode server is unavailable",
  ConflictError: "conflicting change on the server",
};

interface Signal<T> {
  subscribe(listener: (value: T) => void): { unsubscribe(): void };
  emit(value: T): void;
}

function createSignal<T>(): Signal<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return {
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
    emit(value) {
      for (const listener of [...listeners]) {
        try {
          listener(value);
        } catch {
          // Listener errors must never break the adapter or the event pump.
        }
      }
    },
  };
}

/** Abortable sleep; resolves early when `signal` fires. */
function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function readTag(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const tag = (error as Record<string, unknown>)["_tag"];
  return typeof tag === "string" ? tag : undefined;
}

function readReason(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const reason = (error as Record<string, unknown>)["reason"];
  return typeof reason === "string" ? reason : undefined;
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record["status"] === "number") return record["status"];
  if (typeof record["detail"] === "string") {
    const parsed = Number.parseInt(record["detail"], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const cause = record["cause"];
  if (typeof cause === "object" && cause !== null) {
    const status = (cause as Record<string, unknown>)["status"];
    if (typeof status === "number") return status;
  }
  return undefined;
}

function readMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (typeof error === "string" && error.length > 0) return error;
  return "";
}

/**
 * Wraps any SDK failure into an {@link OpenCodeAdapterError}, preserving the
 * SDK's `_tag` (e.g. `SessionBusyError`) and producing an actionable message.
 */
export function wrapSdkError(error: unknown, operation: string, baseUrl: string): OpenCodeAdapterError {
  const tag = readTag(error);
  const status = readStatus(error);
  const original = readMessage(error);
  let message: string;
  if (tag === "UnauthorizedError" || status === 401) {
    message = "authentication failed: check server password";
  } else if (readReason(error) === "Transport") {
    message = `cannot reach the OpenCode server at ${baseUrl} — is it running?`;
  } else {
    const hint = tag !== undefined ? ACTIONABLE_MESSAGES[tag] : undefined;
    if (hint !== undefined) {
      message = original.length > 0 ? `${hint} (${original})` : hint;
    } else if (original.length > 0) {
      message = original;
    } else if (status !== undefined) {
      message = `${operation} failed with HTTP status ${status}`;
    } else {
      message = `${operation} failed`;
    }
  }
  return new OpenCodeAdapterError(operation, message, { tag, cause: error });
}

function basename(uri: string): string {
  const last = uri.split(/[\\/]/).pop();
  return last !== undefined && last.length > 0 ? last : "attachment";
}

export class OpenCodeClientAdapter implements OpenCodeAdapter {
  private baseUrl: string;
  private readonly log: Log;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;

  private status: ConnectionStatus;
  private client: OpenCodeClientLike | null = null;
  private disposed = false;
  private runId = 0;
  private abortController = new AbortController();
  private externalSignalOff: (() => void) | null = null;
  private connectPromise: Promise<void> | null = null;
  /** Last SSE chunk timestamp, for future health reporting. */
  private lastActivityAt = 0;

  private readonly connectionChange: Signal<ConnectionStatus> = createSignal();
  private readonly events: Signal<NormalizedEvent> = createSignal();

  readonly onConnectionChange: {
    subscribe(listener: (status: ConnectionStatus) => void): { unsubscribe(): void };
  };
  readonly onEvent: { subscribe(listener: (event: NormalizedEvent) => void): { unsubscribe(): void } };

  constructor(private readonly options: OpenCodeAdapterOptions) {
    this.baseUrl = (options.getBaseUrl?.() ?? options.baseUrl ?? "").replace(/\/+$/, "");
    this.log = options.logger;
    this.reconnectInitialDelayMs = Math.max(0, options.reconnect?.initialDelayMs ?? 1_000);
    this.reconnectMaxDelayMs = Math.max(this.reconnectInitialDelayMs, options.reconnect?.maxDelayMs ?? 30_000);
    this.status = { state: "disconnected", serverUrl: this.baseUrl };
    this.onConnectionChange = this.connectionChange;
    this.onEvent = this.events;
  }

  get connection(): ConnectionStatus {
    return this.status;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.disposed) throw new OpenCodeAdapterError("connect", "adapter has been disposed");
    if (this.connectPromise !== null) return this.connectPromise;
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  disconnect(): void {
    this.runId += 1;
    this.abortController.abort();
    this.client = null;
    this.connectPromise = null;
    this.setStatus({ state: "disconnected", serverUrl: this.baseUrl });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.externalSignalOff?.();
    this.externalSignalOff = null;
    this.disconnect();
  }

  private async doConnect(): Promise<void> {
    this.runId += 1;
    this.abortController = new AbortController();
    this.wireExternalSignal();

    const dynamicUrl = this.options.getBaseUrl?.();
    if (dynamicUrl) {
      this.baseUrl = dynamicUrl.replace(/\/+$/, "");
    }
    if (!this.baseUrl) {
      throw new OpenCodeAdapterError("connect", "No OpenCode server URL available — start the runtime first.");
    }

    this.setStatus({ state: "connecting", serverUrl: this.baseUrl });
    try {
      const headers = await this.options.getHeaders();
      const factory = this.options.clientFactory ?? ((clientOptions: SdkClientOptions) => OpenCode.make(clientOptions));
      const client = factory({ baseUrl: this.baseUrl, headers, fetch: this.options.fetchFn });
      // Fail fast with an actionable error when the password is wrong.
      const info = await client.server.info({ signal: this.abortController.signal });
      const parsed = serverInfoSchema.safeParse(info);
      this.client = client;
      if (parsed.success) {
        this.log.info(`connected to OpenCode server v${parsed.data.version}`);
      } else {
        this.log.info("connected to OpenCode server");
      }
      this.setStatus({ state: "connected", serverUrl: this.baseUrl });
      void this.pump();
    } catch (error) {
      this.client = null;
      const wrapped = wrapSdkError(error, "connect", this.baseUrl);
      this.log.error(`connect failed: ${wrapped.message}`);
      this.setStatus({ state: "disconnected", serverUrl: this.baseUrl, error: wrapped.message });
      throw wrapped;
    }
  }

  private wireExternalSignal(): void {
    this.externalSignalOff?.();
    this.externalSignalOff = null;
    const external = this.options.eventSignal;
    if (!external) return;
    const forward = (): void => {
      this.abortController.abort();
    };
    if (external.aborted) {
      this.abortController.abort();
      return;
    }
    external.addEventListener("abort", forward, { once: true });
    this.externalSignalOff = () => external.removeEventListener("abort", forward);
  }

  /**
   * Event pump: iterates the SSE subscription, normalizes every event and
   * reconnects with backoff while the adapter is alive.
   */
  private async pump(): Promise<void> {
    const run = this.runId;
    let backoff = this.reconnectInitialDelayMs;
    while (!this.disposed && run === this.runId && !this.abortController.signal.aborted) {
      try {
        const client = this.requireClient();
        const stream = client.event.subscribe(undefined, {
          signal: this.abortController.signal,
          onActivity: () => {
            this.lastActivityAt = Date.now();
          },
        });
        for await (const raw of stream) {
          if (this.disposed || run !== this.runId) return;
          backoff = this.reconnectInitialDelayMs;
          if (this.status.state === "reconnecting") {
            this.setStatus({ state: "connected", serverUrl: this.baseUrl });
          }
          this.emitSdkEvent(raw);
        }
        if (this.disposed || run !== this.runId || this.abortController.signal.aborted) return;
        throw new OpenCodeAdapterError("event-stream", "event stream closed by server");
      } catch (error) {
        if (this.disposed || run !== this.runId || this.abortController.signal.aborted) return;
        const wrapped =
          error instanceof OpenCodeAdapterError ? error : wrapSdkError(error, "event-stream", this.baseUrl);
        this.log.warn(`event stream interrupted: ${wrapped.message}; reconnecting`);
        this.setStatus({ state: "reconnecting", serverUrl: this.baseUrl, error: wrapped.message });
        await waitFor(backoff, this.abortController.signal);
        backoff = Math.min(backoff * 2, this.reconnectMaxDelayMs);
      }
    }
  }

  private emitSdkEvent(raw: unknown): void {
    const parsed = parseV2Event(raw, this.log);
    for (const event of flattenEvents(parsed)) {
      this.events.emit(event);
    }
  }

  private setStatus(next: ConnectionStatus): void {
    const previous = this.status;
    if (previous.state === next.state && previous.error === next.error && previous.serverUrl === next.serverUrl) {
      return;
    }
    this.status = next;
    this.connectionChange.emit(next);
  }

  private requireClient(): OpenCodeClientLike {
    if (this.client === null) {
      throw new OpenCodeAdapterError("client", "adapter is not connected — call connect() first");
    }
    return this.client;
  }

  private async call<T>(operation: string, fn: (client: OpenCodeClientLike) => Promise<T>): Promise<T> {
    const client = this.requireClient();
    try {
      return await fn(client);
    } catch (error) {
      throw wrapSdkError(error, operation, this.baseUrl);
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async serverInfo(): Promise<{ version: string; pid?: number } | undefined> {
    const client = this.client;
    if (client === null) return undefined;
    try {
      const raw = await client.server.info();
      const parsed = serverInfoSchema.safeParse(raw);
      if (!parsed.success) {
        this.log.warn("server.info returned an unexpected payload");
        return undefined;
      }
      return { version: parsed.data.version, pid: parsed.data.pid };
    } catch (error) {
      throw wrapSdkError(error, "serverInfo", this.baseUrl);
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    const raw = await this.call("listSessions", (client) => client.session.list());
    const parsed = listResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn("session.list returned an unexpected payload");
      return [];
    }
    const sessions: SessionSummary[] = [];
    for (const item of parsed.data.data ?? []) {
      const summary = sessionSummaryFromInfo(item);
      if (summary !== null) sessions.push(summary);
    }
    return sessions;
  }

  async createSession(init?: { title?: string; agentID?: string }): Promise<SessionSummary> {
    const input: SessionCreateInput = { title: init?.title, agent: init?.agentID };
    const raw = await this.call("createSession", (client) => client.session.create(input));
    const summary = sessionSummaryFromInfo(raw);
    if (summary === null) {
      throw new OpenCodeAdapterError("createSession", "session.create returned an unexpected payload");
    }
    return summary;
  }

  async getSession(sessionID: string): Promise<SessionSummary | undefined> {
    try {
      const raw = await this.call("getSession", (client) => client.session.get({ sessionID }));
      return sessionSummaryFromInfo(raw) ?? undefined;
    } catch (error) {
      if (error instanceof OpenCodeAdapterError && error.tag === "SessionNotFoundError") return undefined;
      throw error;
    }
  }

  async renameSession(sessionID: string, title: string): Promise<void> {
    await this.call("renameSession", (client) => client.session.update({ sessionID, title }));
  }

  async deleteSession(sessionID: string): Promise<void> {
    await this.call("deleteSession", (client) => client.session.remove({ sessionID }));
  }

  async listMessages(sessionID: string): Promise<ChatMessage[]> {
    const raw = await this.call("listMessages", (client) => client.message.list({ sessionID } satisfies MessageListInput));
    const parsed = messagesResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn("message.list returned an unexpected payload");
      return [];
    }
    const messages: ChatMessage[] = [];
    for (const item of parsed.data.data ?? []) {
      const message = chatMessageFromSdk(item, this.log);
      if (message !== null) messages.push(message);
    }
    return messages;
  }

  async prompt(request: PromptRequest): Promise<void> {
    const client = this.requireClient();
    // Switch the session model first so the prompt runs with the new model.
    if (request.model !== undefined) {
      const switchInput: SessionSwitchModelInput = {
        sessionID: request.sessionID,
        model: {
          id: request.model.modelID,
          providerID: request.model.providerID,
          variant: request.model.variant,
        },
      };
      try {
        await client.session.switchModel(switchInput);
      } catch (error) {
        throw wrapSdkError(error, "prompt:switchModel", this.baseUrl);
      }
    }
    const input: SessionPromptInput = {
      sessionID: request.sessionID,
      text: request.text,
      files: request.files?.map((file) => ({ uri: file.uri, name: file.name })),
    };
    try {
      await client.session.prompt(input);
    } catch (error) {
      throw wrapSdkError(error, "prompt", this.baseUrl);
    }
  }

  async interrupt(sessionID: string): Promise<void> {
    await this.call("interrupt", (client) => client.session.interrupt({ sessionID }));
  }

  async replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionDecision,
    message?: string,
  ): Promise<void> {
    const input: PermissionReplyInput = { sessionID, requestID, decision, message };
    await this.call("replyPermission", (client) => client.permission.reply(input));
  }

  async listPendingPermissions(): Promise<PermissionRequestView[]> {
    const raw = await this.call("listPendingPermissions", (client) => client.permission.request.list());
    const parsed = listResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn("permission.request.list returned an unexpected payload");
      return [];
    }
    const views: PermissionRequestView[] = [];
    for (const item of parsed.data.data ?? []) {
      const view = permissionViewFromSdk(item, Date.now());
      if (view !== null) views.push(view);
    }
    return views;
  }

  async listAgents(): Promise<AgentOption[]> {
    const raw = await this.call("listAgents", (client) => client.agent.list());
    const parsed = listResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn("agent.list returned an unexpected payload");
      return [];
    }
    const agents: AgentOption[] = [];
    for (const item of parsed.data.data ?? []) {
      const validated = agentInfoSchema.safeParse(item);
      if (!validated.success) continue;
      // `hidden` marks internal subagents that must not appear in the picker.
      if (validated.data.hidden === true) continue;
      agents.push({
        id: validated.data.id,
        name: validated.data.name ?? validated.data.id,
        description: validated.data.description,
      });
    }
    return agents;
  }

  async listModels(): Promise<{
    models: ModelOption[];
    providers: ProviderOption[];
    defaultModel?: { providerID: string; modelID: string };
  }> {
    const client = this.requireClient();
    const [modelsRaw, providersRaw] = await Promise.all([
      this.call("listModels", () => client.model.list()),
      this.call("listModels", () => client.provider.list()),
    ]);

    const models: ModelOption[] = [];
    const parsedModels = listResponseSchema.safeParse(redactSdkPayload(modelsRaw));
    if (parsedModels.success) {
      for (const item of parsedModels.data.data ?? []) {
        const validated = modelInfoSchema.safeParse(item);
        if (!validated.success) continue;
        const option = sanitizeModelOption(validated.data);
        if (option !== null) models.push(option);
      }
    } else {
      this.log.warn("model.list returned an unexpected payload");
    }

    const providers: ProviderOption[] = [];
    const parsedProviders = listResponseSchema.safeParse(redactSdkPayload(providersRaw));
    if (parsedProviders.success) {
      for (const item of parsedProviders.data.data ?? []) {
        const validated = providerInfoSchema.safeParse(item);
        if (!validated.success) continue;
        const modelCount = models.filter((model) => model.providerID === validated.data.id).length;
        const option = sanitizeProviderOption(validated.data, modelCount);
        if (option !== null) providers.push(option);
      }
    } else {
      this.log.warn("provider.list returned an unexpected payload");
    }

    let defaultModel: { providerID: string; modelID: string } | undefined;
    try {
      const defaultRaw = await this.call("listModels", () => client.model.default());
      const record = typeof defaultRaw === "object" && defaultRaw !== null ? (defaultRaw as Record<string, unknown>) : null;
      const info = record !== null && "data" in record ? record["data"] : defaultRaw;
      const validated = modelInfoSchema.safeParse(redactSdkPayload(info));
      if (validated.success && validated.data.providerID !== undefined) {
        const modelID = validated.data.modelID ?? validated.data.id;
        if (modelID !== undefined) {
          defaultModel = { providerID: validated.data.providerID, modelID };
        }
      }
    } catch (error) {
      // Older servers may not expose model.default; the catalog is still usable.
      this.log.warn("model.default unavailable", error instanceof Error ? error.message : undefined);
    }

    return { models, providers, defaultModel };
  }

  /** Integration ids that accept an API key, with connection status (redacted). */
  async listKeycapableIntegrations(): Promise<Array<{ id: string; name: string; connected: boolean }>> {
    const raw = await this.call("listKeycapableIntegrations", (client) => client.integration.list());
    const data = typeof raw === "object" && raw !== null && "data" in raw ? (raw as { data: unknown }).data : raw;
    const parsed = z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().optional(),
            methods: z
              .array(z.object({ type: z.string().optional() }).passthrough())
              .optional(),
            connections: z.array(z.object({ method: z.string().optional() }).passthrough()).optional(),
          })
          .passthrough(),
      )
      .safeParse(data);
    if (!parsed.success) {
      this.log.warn("integration.list returned an unexpected payload");
      return [];
    }
    const connectedIds = new Set(
      parsed.data
        .filter((it) => (it.connections ?? []).some((c) => c.method !== undefined))
        .map((it) => it.id),
    );
    return parsed.data
      .filter((it) => (it.methods ?? []).some((m) => m.type === "key"))
      .map((it) => ({ id: it.id, name: it.name ?? it.id, connected: connectedIds.has(it.id) }));
  }

  /**
   * Stores and activates an API key for an integration via the official
   * connect API. The key is passed straight through to the server and is
   * never logged here; server errors are wrapped without echoing the key.
   */
  async setProviderKey(integrationID: string, key: string, label?: string): Promise<void> {
    if (key.trim().length === 0) {
      throw new OpenCodeAdapterError("setProviderKey", "API key must not be empty.");
    }
    try {
      await this.call("setProviderKey", (client) =>
        client.integration.connect.key({ integrationID, key: key.trim(), label: label ?? integrationID }),
      );
      this.log.info(`API key stored for integration "${integrationID}"`);
    } catch (error) {
      const wrapped = error instanceof OpenCodeAdapterError ? error : wrapSdkError(error, "setProviderKey", this.baseUrl);
      throw new OpenCodeAdapterError("setProviderKey", `Could not store the API key for "${integrationID}": ${wrapped.message}`, {
        tag: wrapped instanceof OpenCodeAdapterError ? wrapped.tag : undefined,
        cause: wrapped,
      });
    }
  }

  /** Redacted credential overview — ids, labels, activity; never key material. */
  async listCredentialSummary(): Promise<Array<{ integrationID: string; label: string; active: boolean; hasKey: boolean }>> {
    const raw = await this.call("listCredentialSummary", (client) => client.credential.list());
    const parsed = z
      .array(
        z
          .object({
            integrationID: z.string(),
            label: z.string().default(""),
            active: z.boolean().default(false),
            value: z.object({ type: z.string().optional() }).passthrough().optional(),
          })
          .passthrough(),
      )
      .safeParse(raw);
    if (!parsed.success) return [];
    return parsed.data.map((c) => ({
      integrationID: c.integrationID,
      label: c.label,
      active: c.active,
      hasKey: c.value?.type === "key",
    }));
  }

  /** Branches the conversation via the official session.fork API. */
  async forkSession(sessionID: string, beforeMessageID?: string): Promise<SessionSummary> {
    const raw = await this.call("forkSession", (client) =>
      client.session.fork({ sessionID, before: beforeMessageID ?? undefined } satisfies SessionForkInput),
    );
    const record = typeof raw === "object" && raw !== null && "data" in raw ? (raw as { data: unknown }).data : raw;
    const summary = sessionSummaryFromInfo(record);
    if (!summary) {
      throw new OpenCodeAdapterError("forkSession", "The server returned an unexpected payload for the forked session.");
    }
    this.log.info("Session forked", { from: sessionID, to: summary.id, before: beforeMessageID ?? "end" });
    return summary;
  }

  async sessionDiff(
    sessionID: string,
  ): Promise<Array<{ file: string; patch: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" }>> {    const raw = await this.call("sessionDiff", (client) => client.session.diff({ sessionID } satisfies SessionDiffInput));
    const parsed = fileDiffListSchema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn("session.diff returned an unexpected payload");
      return [];
    }
    return parsed.data.map((diff) => ({
      file: diff.file,
      patch: diff.patch,
      additions: diff.additions,
      deletions: diff.deletions,
      status: diff.status,
    }));
  }
}

// -----------------------------------------------------------------------------
// Message mapping
// -----------------------------------------------------------------------------

function chatMessageFromSdk(item: unknown, log: Log): ChatMessage | null {
  if (typeof item !== "object" || item === null) return null;
  const type = (item as Record<string, unknown>)["type"];
  if (type === "user") {
    const parsed = userMessageSchema.safeParse(item);
    if (!parsed.success) return null;
    const d = parsed.data;
    const attachments: AttachmentView[] = (d.files ?? []).map((file) => {
      const source = file.source ?? {};
      const uri = typeof source["uri"] === "string" ? source["uri"] : "";
      return {
        name: file.name ?? (uri.length > 0 ? basename(uri) : "attachment"),
        uri,
        kind: "file",
      };
    });
    return {
      id: d.id,
      role: "user",
      text: d.text ?? "",
      tools: [],
      attachments,
      createdAt: d.time?.created ?? 0,
      streaming: false,
    };
  }
  if (type === "assistant") {
    const parsed = assistantMessageSchema.safeParse(item);
    if (!parsed.success) return null;
    const d = parsed.data;
    let text = "";
    let reasoning = "";
    const tools: ToolCallView[] = [];
    for (const part of d.content ?? []) {
      const partType = part["type"];
      if (partType === "text" && typeof part["text"] === "string") {
        text += part["text"];
      } else if (partType === "reasoning" && typeof part["text"] === "string") {
        reasoning += part["text"];
      } else if (partType === "tool") {
        const toolPart = toolPartSchema.safeParse(part);
        if (toolPart.success) tools.push(toolCallViewFromPart(toolPart.data));
        else log.warn("dropped a malformed tool part");
      }
    }
    const model = d.model;
    const tokens = d.tokens;
    return {
      id: d.id,
      role: "assistant",
      text,
      reasoning: reasoning.length > 0 ? reasoning : undefined,
      tools,
      attachments: [],
      createdAt: d.time?.created ?? 0,
      updatedAt: d.time?.completed,
      model: model === undefined ? undefined : { providerID: model.providerID, modelID: model.modelID ?? model.id ?? "" },
      cost: d.cost,
      tokens:
        tokens === undefined
          ? undefined
          : {
              input: tokens.input ?? 0,
              output: tokens.output ?? 0,
              reasoning: tokens.reasoning ?? 0,
              cacheRead: tokens.cache?.read ?? 0,
              cacheWrite: tokens.cache?.write ?? 0,
            },
      streaming: d.time?.completed === undefined && d.error === undefined,
      outcome: d.error === undefined ? undefined : "failed",
      error: errorText(d.error),
    };
  }
  // System, synthetic, compaction, idle, … messages are not part of the chat view.
  return null;
}

function toolCallViewFromPart(part: {
  id?: string;
  callID?: string;
  name?: string;
  tool?: string;
  state?: {
    status: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    metadata?: Record<string, unknown>;
    content?: Array<Record<string, unknown>>;
  };
  time?: { created?: number; ran?: number; completed?: number };
}): ToolCallView {
  const state = part.state;
  const status =
    state === undefined
      ? "pending"
      : state.status === "completed"
        ? "success"
        : state.status === "error"
          ? "error"
          : state.status === "pending"
            ? "pending"
            : "running"; // "running" and "streaming" both render as in-flight.
  const metadata = state?.metadata;
  const title = metadata !== undefined && typeof metadata["title"] === "string" ? metadata["title"] : undefined;
  const file = metadata !== undefined && typeof metadata["file"] === "string" ? metadata["file"] : undefined;
  return {
    callID: part.callID ?? part.id ?? "",
    tool: part.tool ?? part.name ?? "unknown",
    title: title !== undefined && title.length > 0 ? title : undefined,
    status,
    input: state?.input === undefined ? undefined : parseJsonish(state.input),
    output: toolOutputText(state?.output, state?.content),
    error: state === undefined ? undefined : errorText(state.error),
    file,
    startedAt: part.time?.created,
    finishedAt: part.time?.completed,
  };
}

// Re-exported so host code can normalize raw events without importing the SDK.
export { permissionViewFromSdk, sessionSummaryFromInfo } from "./eventNormalizer";
export type { NormalizedEvent } from "./types";

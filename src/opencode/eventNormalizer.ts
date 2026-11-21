/**
 * Maps raw OpenCode V2 events onto the UI-facing {@link NormalizedEvent} union.
 *
 * Field names are reconciled across the generated client types (v2.3.x: tool
 * events keyed by `id`, permission replies under `reply`, `session.created`
 * carrying a flat payload) and docs/OPENCODE-CONTRACT.md (server v2.2.6:
 * `callID`, `decision`, `data.info`). Anything unrecognized degrades to
 * `null` or `{ kind: "unknown" }` — mapping never throws.
 */

import type { V2Event } from "@opencode/client";
import type { ModelRef, PermissionRequestView, SessionSummary } from "../../shared/protocol";
import type { Log } from "../core/logger";
import { redactSdkPayload } from "./redact";
import {
  executionData,
  filesystemData,
  messageStreamData,
  permissionAskedData,
  permissionRepliedData,
  sessionCreatedData,
  sessionInfoSchema,
  sessionRenamedData,
  sessionIdData,
  sessionStatusData,
  toolEventData,
  usageData,
  versionData,
} from "./schemas";
import type { NormalizedEvent } from "./types";

/**
 * Structural subset of the SDK's `V2Event` union, so both real SDK events and
 * hand-written fixtures (which may use older field spellings) can be mapped.
 */
export interface V2EventLike {
  type: string;
  created?: number;
  id?: string;
  data?: unknown;
}

/** Event types the SDK emits that this extension deliberately ignores. */
const IGNORED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "server.connected",
  "session.metadata.updated",
  "session.viewed",
  "session.archived",
  "session.unarchived",
  "session.forked",
  "session.moved",
  "session.permissions",
  "session.agent.selected",
  "session.model.selected",
  "session.inbox.delivered",
  "session.inbox.enqueued",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.instructions.updated",
  "session.synthetic",
  "session.skill.activated",
  "session.shell.started",
  "session.shell.ended",
  "session.step.started",
  "session.step.first-token",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.compaction.started",
  "session.compaction.delta",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.revert.staged",
  "session.revert.cleared",
  "session.revert.committed",
  "session.message.content.updated",
  "installation.updated",
  "models-dev.refreshed",
  "credential.updated",
  "credential.switched",
  "integration.updated",
  "provider.updated",
  "model.updated",
  "agent.updated",
  "plugin.updated",
  "project.updated",
  "worktree.updated",
  "worktree.resolved",
  "command.updated",
  "config.updated",
  "skill.updated",
  "reference.updated",
  "websearch.updated",
  "artifact.updated",
  "vcs.branch.updated",
  "mcp.status.changed",
  "mcp.resources.changed",
  "experimental.mcp.event",
]);

const IGNORED_EVENT_PREFIXES: readonly string[] = ["tui.", "pty.", "persistent-pty.", "shell.", "form.", "rpc."];

type TextStreamKind = "text.started" | "text.delta" | "text.ended" | "reasoning.started" | "reasoning.delta" | "reasoning.ended";

/** SDK event type → normalized stream kind. */
const TEXT_EVENT_KINDS: Readonly<Record<string, TextStreamKind>> = {
  "session.text.started": "text.started",
  "session.text.delta": "text.delta",
  "session.text.ended": "text.ended",
  "session.reasoning.started": "reasoning.started",
  "session.reasoning.delta": "reasoning.delta",
  "session.reasoning.ended": "reasoning.ended",
};

/**
 * Maps one SDK event to a normalized event, a fan-out list, or `null`.
 *
 * `V2Event` (typed SDK events) and {@link V2EventLike} fixtures are both
 * accepted; payload shapes are validated tolerantly inside each branch.
 */
export function mapV2Event(event: V2Event | V2EventLike, logger?: Log): NormalizedEvent | NormalizedEvent[] | null {
  // Field access goes through the structural view: a few SDK union members
  // (e.g. the `server.connected` event) omit optional fields like `created`.
  const like = event as V2EventLike;
  const type = like.type;
  const created = typeof like.created === "number" ? like.created : undefined;
  const data: unknown = like.data;
  switch (type) {
    case "location.shutdown":
      return { kind: "server.shutdown" };
    case "session.created":
      return sessionUpdatedFromCreated(data, created);
    case "session.renamed":
      return sessionUpdatedFromRenamed(data, created);
    case "session.deleted": {
      const parsed = sessionIdData.safeParse(data);
      return parsed.success ? { kind: "session.deleted", sessionID: parsed.data.sessionID } : null;
    }
    case "session.idle": {
      const parsed = sessionIdData.safeParse(data);
      return parsed.success ? { kind: "session.idle", sessionID: parsed.data.sessionID } : null;
    }
    case "session.execution.started": {
      const parsed = executionData.safeParse(data);
      return parsed.success ? { kind: "session.busy", sessionID: parsed.data.sessionID, busy: true } : null;
    }
    case "session.execution.succeeded": {
      const parsed = executionData.safeParse(data);
      return parsed.success
        ? { kind: "session.idle", sessionID: parsed.data.sessionID, outcome: "succeeded" }
        : null;
    }
    case "session.execution.failed": {
      const parsed = executionData.safeParse(data);
      if (!parsed.success) return null;
      return {
        kind: "session.idle",
        sessionID: parsed.data.sessionID,
        outcome: "failed",
        error: parsed.data.error?.message,
      };
    }
    case "session.execution.interrupted": {
      const parsed = executionData.safeParse(data);
      return parsed.success
        ? { kind: "session.idle", sessionID: parsed.data.sessionID, outcome: "interrupted" }
        : null;
    }
    case "session.retry.scheduled": {
      const parsed = executionData.safeParse(data);
      if (!parsed.success) return null;
      const attempt = parsed.data.attempt ?? 0;
      return {
        kind: "session.retry",
        sessionID: parsed.data.sessionID,
        attempt,
        message: parsed.data.error?.message ?? `retrying (attempt ${attempt})`,
      };
    }
    case "session.status": {
      const parsed = sessionStatusData.safeParse(data);
      if (!parsed.success) return null;
      const { sessionID, status } = parsed.data;
      if (status.type === "busy") return { kind: "session.busy", sessionID, busy: true };
      if (status.type === "idle") return { kind: "session.busy", sessionID, busy: false };
      if (status.type === "retry") {
        const attempt = status.attempt ?? 0;
        return {
          kind: "session.retry",
          sessionID,
          attempt,
          message: status.message ?? `retrying (attempt ${attempt})`,
        };
      }
      return null;
    }
    case "session.usage.updated":
    case "session.usage.recorded":
      return sessionUpdatedFromUsage(data, created);
    case "session.text.started":
    case "session.text.delta":
    case "session.text.ended":
    case "session.reasoning.started":
    case "session.reasoning.delta":
    case "session.reasoning.ended": {
      const kind = TEXT_EVENT_KINDS[type];
      return kind === undefined ? null : textStreamEvent(kind, data);
    }
    case "session.tool.called":
    case "session.tool.input.started":
      return toolStartOrInput(data);
    case "session.tool.input.delta":
      // Input arrives as streaming JSON fragments; the UI only needs the final value.
      return null;
    case "session.tool.input.ended":
      return toolInputFromEnded(data);
    case "session.tool.progress":
      return toolProgress(data);
    case "session.tool.success":
      return toolCompleted(data, "success");
    case "session.tool.failed":
      return toolCompleted(data, "error");
    case "permission.asked": {
      const request = permissionViewFromSdk(data, created ?? Date.now());
      return request ? { kind: "permission.asked", request } : null;
    }
    case "permission.replied": {
      const parsed = permissionRepliedData.safeParse(data);
      if (!parsed.success) return null;
      const decision = parsed.data.reply ?? parsed.data.decision;
      if (decision !== "once" && decision !== "always" && decision !== "reject") return null;
      return {
        kind: "permission.replied",
        sessionID: parsed.data.sessionID,
        requestID: parsed.data.requestID,
        decision,
      };
    }
    case "filesystem.changed": {
      const parsed = filesystemData.safeParse(data);
      return parsed.success
        ? { kind: "file.changed", file: parsed.data.file, change: parsed.data.event }
        : null;
    }
    case "installation.update-available": {
      const parsed = versionData.safeParse(data);
      return parsed.success ? { kind: "update.available", version: parsed.data.version } : null;
    }
    default:
      if (IGNORED_EVENT_TYPES.has(type) || IGNORED_EVENT_PREFIXES.some((p) => type.startsWith(p))) {
        return null;
      }
      logger?.debug("unrecognized event type", { type });
      return { kind: "unknown", type };
  }
}

/**
 * Projects a raw `Permission.Request` (event payload or `permission.request.list`
 * item) into a {@link PermissionRequestView}. Metadata is redacted before it
 * can reach the webview; `askedAt` falls back to the caller-provided time for
 * list endpoints that do not carry a timestamp.
 */
export function permissionViewFromSdk(raw: unknown, askedAt: number): PermissionRequestView | null {
  const parsed = permissionAskedData.safeParse(redactSdkPayload(raw));
  if (!parsed.success) return null;
  const d = parsed.data;
  return {
    requestID: d.id,
    sessionID: d.sessionID,
    action: d.action,
    title: d.message ? `${d.action}: ${d.message}` : d.action,
    message: d.message,
    resources: d.resources ?? [],
    saveScopes: d.save ?? [],
    metadata: d.metadata,
    askedAt,
  };
}

/**
 * Projects a raw `Session.Info` into a {@link SessionSummary}. Returns `null`
 * when the payload lacks an `id`.
 */
export function sessionSummaryFromInfo(raw: unknown, fallbackTime?: number): SessionSummary | null {
  const parsed = sessionInfoSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  const now = fallbackTime ?? Date.now();
  const createdAt = d.time?.created ?? now;
  const summary: SessionSummary = {
    id: d.id,
    title: d.title ?? "Untitled",
    createdAt,
    updatedAt: d.time?.updated ?? createdAt,
    model: modelRefFrom(d.model),
    agent: d.agent,
    cost: d.cost,
  };
  // `time.busy` is set while a run is active and cleared (with `time.idle`) after.
  if (d.time && d.time.busy !== undefined && d.time.idle === undefined) summary.busy = true;
  return summary;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sessionUpdatedFromCreated(data: unknown, created: number | undefined): NormalizedEvent | null {
  const parsed = sessionCreatedData.safeParse(data);
  if (parsed.success) {
    // Newer servers may embed the full Session.Info under `data.info`.
    const fromInfo = parsed.data.info !== undefined ? sessionSummaryFromInfo(parsed.data.info, created) : null;
    if (fromInfo) return { kind: "session.updated", session: fromInfo };
    const now = created ?? Date.now();
    return {
      kind: "session.updated",
      session: {
        id: parsed.data.sessionID,
        title: parsed.data.title ?? "Untitled",
        createdAt: now,
        updatedAt: now,
        model: modelRefFrom(parsed.data.model),
        agent: parsed.data.agent,
      },
    };
  }
  // Older shape: session payload under `data.info` only.
  const record = asRecord(data);
  const info = record?.["info"];
  if (info !== undefined) {
    const fromInfo = sessionSummaryFromInfo(info, created);
    if (fromInfo) return { kind: "session.updated", session: fromInfo };
  }
  return null;
}

function sessionUpdatedFromRenamed(data: unknown, created: number | undefined): NormalizedEvent | null {
  const parsed = sessionRenamedData.safeParse(data);
  if (parsed.success && parsed.data.title !== undefined) {
    const now = created ?? Date.now();
    return {
      kind: "session.updated",
      session: { id: parsed.data.sessionID, title: parsed.data.title, createdAt: now, updatedAt: now },
    };
  }
  const record = asRecord(data);
  const info = record?.["info"];
  if (info !== undefined) {
    const fromInfo = sessionSummaryFromInfo(info, created);
    if (fromInfo) return { kind: "session.updated", session: fromInfo };
  }
  return null;
}

/**
 * Folds usage updates into `session.updated`. The summary carries only the
 * fields known from this event (empty title signals "unchanged"); consumers
 * merge partial summaries by session id.
 */
function sessionUpdatedFromUsage(data: unknown, created: number | undefined): NormalizedEvent | null {
  const parsed = usageData.safeParse(data);
  if (!parsed.success) return null;
  const now = created ?? Date.now();
  const session: SessionSummary = { id: parsed.data.sessionID, title: "", createdAt: now, updatedAt: now };
  if (parsed.data.cost !== undefined) session.cost = parsed.data.cost;
  return { kind: "session.updated", session };
}

function textStreamEvent(kind: TextStreamKind, data: unknown): NormalizedEvent | null {
  const parsed = messageStreamData.safeParse(data);
  if (!parsed.success) return null;
  const d = parsed.data;
  // Events are keyed by the assistant message they belong to.
  const messageID = d.assistantMessageID ?? d.messageID;
  if (!messageID) return null;
  const base = { sessionID: d.sessionID, messageID };
  switch (kind) {
    case "text.started":
    case "reasoning.started":
      return { kind, ...base };
    case "text.delta":
    case "reasoning.delta": {
      const delta = d.delta ?? d.text;
      if (delta === undefined) return null;
      return { kind, ...base, delta };
    }
    case "text.ended":
    case "reasoning.ended":
      return { kind, ...base, text: d.text ?? d.delta };
  }
}

/**
 * `session.tool.called` (v2.2.6: `callID`/`tool`/`title`; v2.3.x: `id` +
 * `input`) and `session.tool.input.started` (v2.3.x: `id` + `name`) both
 * introduce a tool call, so they share one branch: emit `tool.started` when a
 * tool name is known and `tool.input` when an input payload is present.
 */
function toolStartOrInput(data: unknown): NormalizedEvent | NormalizedEvent[] | null {
  const parsed = toolEventData.safeParse(data);
  if (!parsed.success) return null;
  const d = parsed.data;
  const callID = d.callID ?? d.id;
  if (!callID) return null;
  const events: NormalizedEvent[] = [];
  const tool = d.tool ?? d.name;
  if (tool !== undefined) {
    events.push({
      kind: "tool.started",
      sessionID: d.sessionID,
      callID,
      tool,
      title: d.title,
      messageID: d.assistantMessageID,
    });
  }
  if (d.input !== undefined) {
    events.push({ kind: "tool.input", sessionID: d.sessionID, callID, input: d.input });
  }
  if (events.length === 0) return null;
  const [first] = events;
  if (events.length === 1 && first !== undefined) return first;
  return events;
}

/** `session.tool.input.ended` delivers the input as a JSON string (`text`). */
function toolInputFromEnded(data: unknown): NormalizedEvent | null {
  const parsed = toolEventData.safeParse(data);
  if (!parsed.success) return null;
  const d = parsed.data;
  const callID = d.callID ?? d.id;
  if (!callID) return null;
  const raw = d.text !== undefined ? d.text : d.input;
  return { kind: "tool.input", sessionID: d.sessionID, callID, input: parseJsonish(raw) };
}

function toolProgress(data: unknown): NormalizedEvent | null {
  const parsed = toolEventData.safeParse(data);
  if (!parsed.success) return null;
  const d = parsed.data;
  const callID = d.callID ?? d.id;
  if (!callID) return null;
  return {
    kind: "tool.progress",
    sessionID: d.sessionID,
    callID,
    output: typeof d.output === "string" ? d.output : undefined,
  };
}

function toolCompleted(data: unknown, status: "success" | "error"): NormalizedEvent | null {
  const parsed = toolEventData.safeParse(data);
  if (!parsed.success) return null;
  const d = parsed.data;
  const callID = d.callID ?? d.id;
  if (!callID) return null;
  return {
    kind: "tool.completed",
    sessionID: d.sessionID,
    callID,
    status,
    output: toolOutputText(d.output, d.content),
    error: status === "error" ? (errorText(d.error) ?? "tool call failed") : undefined,
    metadata: d.metadata,
  };
}

/** SDK `ModelRef` (`id`) → protocol `ModelRef` (`modelID`). */
function modelRefFrom(model: { id?: string; modelID?: string; providerID: string; variant?: string } | undefined): ModelRef | undefined {
  if (!model) return undefined;
  const modelID = model.modelID ?? model.id;
  if (!modelID) return undefined;
  return { providerID: model.providerID, modelID, variant: model.variant };
}

/** Joins the `{ type: "text", text }` items of a tool `content` array. */
export function toolOutputText(output: unknown, content: Array<Record<string, unknown>> | undefined): string | undefined {
  if (typeof output === "string") return output;
  if (content !== undefined) {
    const text = content
      .filter((item) => item["type"] === "text" && typeof item["text"] === "string")
      .map((item) => item["text"] as string)
      .join("\n");
    if (text.length > 0) return text;
  }
  if (output !== undefined) return JSON.stringify(output);
  return undefined;
}

/** Extracts a human-readable message from a string or structured error. */
export function errorText(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  const record = asRecord(error);
  const message = record?.["message"];
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

/** Parses JSON-encoded strings (tool inputs); passes everything else through. */
export function parseJsonish(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // Not JSON — keep the raw string (e.g. partial tool input).
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

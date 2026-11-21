/**
 * Zod schemas for everything that crosses the OpenCode SDK boundary.
 *
 * Shapes are intentionally TOLERANT: `.passthrough()` everywhere, optional
 * fields, coerced numbers, and both the field names verified against
 * `@opencode/client@2.3.2` generated types (e.g. tool events carrying `id`)
 * and the variants documented in docs/OPENCODE-CONTRACT.md (e.g. `callID`).
 * Validation failures must degrade to `null`, never throw into the UI.
 */

import { z } from "zod";
import type { Log } from "../core/logger";
import type { NormalizedEvent } from "./types";
import { mapV2Event } from "./eventNormalizer";

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------

export const v2EventEnvelopeSchema = z
  .object({
    type: z.string().min(1),
    created: z.coerce.number().optional(),
    id: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Shared payload fragments
// ---------------------------------------------------------------------------

export const modelRefData = z
  .object({
    id: z.string().optional(),
    modelID: z.string().optional(),
    providerID: z.string(),
    variant: z.string().optional(),
  })
  .passthrough();

export const sessionIdData = z.object({ sessionID: z.string() }).passthrough();

/** `session.text.*` / `session.reasoning.*` payloads. */
export const messageStreamData = z
  .object({
    sessionID: z.string(),
    assistantMessageID: z.string().optional(),
    messageID: z.string().optional(),
    delta: z.string().optional(),
    text: z.string().optional(),
    ordinal: z.coerce.number().optional(),
  })
  .passthrough();

/**
 * `session.tool.*` payloads. The generated client types (v2.3.x) key tool
 * calls by `id` and name the tool only in `session.tool.input.started`
 * (`name`); docs/OPENCODE-CONTRACT.md (verified against server v2.2.6) uses
 * `callID` / `tool` / `title` and string `output` / `error`. Accept both.
 */
export const toolEventData = z
  .object({
    sessionID: z.string(),
    assistantMessageID: z.string().optional(),
    id: z.string().optional(),
    callID: z.string().optional(),
    name: z.string().optional(),
    tool: z.string().optional(),
    title: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
    text: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    content: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough();

export const sessionStatusData = z
  .object({
    sessionID: z.string(),
    status: z
      .object({
        type: z.string(),
        attempt: z.coerce.number().optional(),
        message: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const usageData = z
  .object({
    sessionID: z.string(),
    cost: z.coerce.number().optional(),
    tokens: z.record(z.unknown()).optional(),
  })
  .passthrough();

/** `session.execution.*` and `session.retry.scheduled` payloads. */
export const executionData = z
  .object({
    sessionID: z.string(),
    error: z.object({ message: z.string().optional() }).passthrough().optional(),
    reason: z.string().optional(),
    attempt: z.coerce.number().optional(),
  })
  .passthrough();

export const permissionAskedData = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    action: z.string(),
    resources: z.array(z.string()).optional(),
    save: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
    message: z.string().optional(),
  })
  .passthrough();

export const permissionRepliedData = z
  .object({
    sessionID: z.string(),
    requestID: z.string(),
    reply: z.string().optional(),
    decision: z.string().optional(),
  })
  .passthrough();

export const filesystemData = z
  .object({ file: z.string(), event: z.enum(["add", "change", "unlink"]) })
  .passthrough();

export const versionData = z.object({ version: z.string() }).passthrough();

export const sessionCreatedData = z
  .object({
    sessionID: z.string(),
    title: z.string().optional(),
    agent: z.string().optional(),
    model: modelRefData.optional(),
    info: z.unknown().optional(),
  })
  .passthrough();

export const sessionRenamedData = z
  .object({
    sessionID: z.string(),
    title: z.string().optional(),
    info: z.unknown().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Response payload schemas (used by the adapter's query methods)
// ---------------------------------------------------------------------------

export const serverInfoSchema = z
  .object({ version: z.string(), pid: z.coerce.number().optional() })
  .passthrough();

export const sessionInfoSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    agent: z.string().optional(),
    model: modelRefData.optional(),
    cost: z.coerce.number().optional(),
    time: z
      .object({
        created: z.coerce.number().optional(),
        updated: z.coerce.number().optional(),
        busy: z.coerce.number().optional(),
        idle: z.coerce.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const tokenUsageSchema = z
  .object({
    input: z.coerce.number().optional(),
    output: z.coerce.number().optional(),
    reasoning: z.coerce.number().optional(),
    cache: z
      .object({ read: z.coerce.number().optional(), write: z.coerce.number().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** A `tool` part inside an assistant message's `content` array. */
export const toolPartSchema = z
  .object({
    type: z.literal("tool"),
    id: z.string().optional(),
    callID: z.string().optional(),
    name: z.string().optional(),
    tool: z.string().optional(),
    state: z
      .object({
        status: z.string(),
        input: z.unknown().optional(),
        output: z.unknown().optional(),
        error: z.unknown().optional(),
        metadata: z.record(z.unknown()).optional(),
        content: z.array(z.record(z.unknown())).optional(),
      })
      .passthrough()
      .optional(),
    time: z
      .object({
        created: z.coerce.number().optional(),
        ran: z.coerce.number().optional(),
        completed: z.coerce.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const assistantMessageSchema = z
  .object({
    id: z.string(),
    type: z.literal("assistant"),
    agent: z.string().optional(),
    model: modelRefData.optional(),
    cost: z.coerce.number().optional(),
    tokens: tokenUsageSchema.optional(),
    error: z.object({ message: z.string().optional() }).passthrough().optional(),
    time: z
      .object({
        created: z.coerce.number().optional(),
        firstToken: z.coerce.number().optional(),
        streamed: z.coerce.number().optional(),
        completed: z.coerce.number().optional(),
      })
      .passthrough()
      .optional(),
    content: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough();

export const userMessageSchema = z
  .object({
    id: z.string(),
    type: z.literal("user"),
    text: z.string().optional(),
    time: z.object({ created: z.coerce.number().optional() }).passthrough().optional(),
    files: z
      .array(
        z
          .object({
            name: z.string().optional(),
            mime: z.string().optional(),
            source: z.record(z.unknown()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const messagesResponseSchema = z.object({ data: z.array(z.unknown()).optional() }).passthrough();

/** Generic `{ location, data: T[] }` list envelope used by most endpoints. */
export const listResponseSchema = z.object({ data: z.array(z.unknown()).optional() }).passthrough();

export const fileDiffSchema = z
  .object({
    file: z.string(),
    patch: z.string(),
    additions: z.coerce.number(),
    deletions: z.coerce.number(),
    status: z.enum(["added", "deleted", "modified"]),
  })
  .passthrough();

export const fileDiffListSchema = z.array(fileDiffSchema);

export const agentInfoSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    hidden: z.boolean().optional(),
    mode: z.string().optional(),
  })
  .passthrough();

export const modelInfoSchema = z
  .object({
    id: z.string().optional(),
    modelID: z.string().optional(),
    providerID: z.string().optional(),
    name: z.string().optional(),
    family: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

export const providerInfoSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    activation: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// parseV2Event — tolerant entry point for the event pump
// ---------------------------------------------------------------------------

/** A single mapped event, or the fan-out produced by tool/permission events. */
export type ParsedV2Event = NormalizedEvent | NormalizedEvent[];

/**
 * Validates a raw SSE event and maps it to {@link NormalizedEvent}(s).
 *
 * Returns `null` for malformed envelopes and for known-but-uninteresting or
 * unrecognized event types (logged via the injected logger, never thrown).
 * Tool events can fan out, so the result may be an array.
 */
export function parseV2Event(raw: unknown, logger?: Log): ParsedV2Event | null {
  try {
    const parsed = v2EventEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      logger?.debug("dropping event with malformed envelope");
      return null;
    }
    const mapped = mapV2Event(
      { type: parsed.data.type, created: parsed.data.created, id: parsed.data.id, data: parsed.data.data },
      logger,
    );
    if (mapped === null) return null;
    if (Array.isArray(mapped)) return mapped.length > 0 ? mapped : null;
    if (mapped.kind === "unknown") {
      logger?.debug("dropping unrecognized event type", { type: mapped.type });
      return null;
    }
    return mapped;
  } catch (error) {
    logger?.warn("event parsing failed; dropping event", error);
    return null;
  }
}

/** Flattens a {@link ParsedV2Event} into a plain list (empty for `null`). */
export function flattenEvents(parsed: ParsedV2Event | null): NormalizedEvent[] {
  if (parsed === null) return [];
  return Array.isArray(parsed) ? [...parsed] : [parsed];
}

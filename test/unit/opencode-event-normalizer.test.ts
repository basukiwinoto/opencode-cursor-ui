import { describe, expect, it, vi } from "vitest";
import type { Log } from "../../src/core/logger";
import {
  errorText,
  mapV2Event,
  parseJsonish,
  permissionViewFromSdk,
  sessionSummaryFromInfo,
} from "../../src/opencode/eventNormalizer";
import { flattenEvents, parseV2Event } from "../../src/opencode/schemas";

/** Shell for every event fixture — matches the verified envelope. */
function envelope(type: string, data: unknown, created = 1_700_000_000_000): unknown {
  return { id: "evt_1", created, type, data };
}

const silentLog: Log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("mapV2Event — text and reasoning streams", () => {
  it("maps a text delta keyed by assistantMessageID", () => {
    const event = mapV2Event({
      type: "session.text.delta",
      created: 1_700_000_000_000,
      data: { sessionID: "ses_1", assistantMessageID: "msg_a1", ordinal: 0, delta: "hello " },
    });
    expect(event).toEqual({
      kind: "text.delta",
      sessionID: "ses_1",
      messageID: "msg_a1",
      delta: "hello ",
    });
  });

  it("maps text started/ended and reasoning streams", () => {
    expect(
      mapV2Event({
        type: "session.text.started",
        data: { sessionID: "ses_1", assistantMessageID: "msg_a1", ordinal: 0 },
      }),
    ).toEqual({ kind: "text.started", sessionID: "ses_1", messageID: "msg_a1" });
    expect(
      mapV2Event({
        type: "session.text.ended",
        data: { sessionID: "ses_1", assistantMessageID: "msg_a1", ordinal: 0, text: "done" },
      }),
    ).toEqual({ kind: "text.ended", sessionID: "ses_1", messageID: "msg_a1", text: "done" });
    expect(
      mapV2Event({
        type: "session.reasoning.delta",
        data: { sessionID: "ses_1", assistantMessageID: "msg_a1", ordinal: 0, delta: "thinking" },
      }),
    ).toEqual({ kind: "reasoning.delta", sessionID: "ses_1", messageID: "msg_a1", delta: "thinking" });
  });

  it("drops stream events without a message id", () => {
    expect(mapV2Event({ type: "session.text.delta", data: { sessionID: "ses_1", delta: "x" } })).toBeNull();
  });
});

describe("mapV2Event — permission events", () => {
  it("maps permission.asked into a redacted view with saveScopes", () => {
    // Fixture copied from docs/OPENCODE-CONTRACT.md §5.
    const event = mapV2Event({
      type: "permission.asked",
      created: 1_700_000_000_123,
      data: {
        id: "per_1",
        sessionID: "ses_1",
        action: "bash",
        resources: ["/tmp/install.sh"],
        save: ["once", "always"],
        metadata: { apiKey: "sk-live-0000000000000000", tool: "bash" },
        message: "run install.sh?",
      },
    });
    expect(event).not.toBeNull();
    const view = (event as { kind: string; request: { [key: string]: unknown } }).request;
    expect(view["requestID"]).toBe("per_1");
    expect(view["sessionID"]).toBe("ses_1");
    expect(view["action"]).toBe("bash");
    // Title derives from action + message; askedAt from the envelope.
    expect(view["title"]).toBe("bash: run install.sh?");
    expect(view["saveScopes"]).toEqual(["once", "always"]);
    expect(view["askedAt"]).toBe(1_700_000_000_123);
    // Secrets are stripped from metadata before it reaches the view.
    expect(JSON.stringify(view)).not.toContain("sk-live");
    expect((view["metadata"] as Record<string, unknown>)["tool"]).toBe("bash");
  });

  it("maps permission.replied via the `reply` field (and tolerates `decision`)", () => {
    expect(
      mapV2Event({
        type: "permission.replied",
        data: { sessionID: "ses_1", requestID: "per_1", reply: "always" },
      }),
    ).toEqual({ kind: "permission.replied", sessionID: "ses_1", requestID: "per_1", decision: "always" });
    expect(
      mapV2Event({
        type: "permission.replied",
        data: { sessionID: "ses_1", requestID: "per_1", decision: "reject" },
      }),
    ).toEqual({ kind: "permission.replied", sessionID: "ses_1", requestID: "per_1", decision: "reject" });
    expect(
      mapV2Event({
        type: "permission.replied",
        data: { sessionID: "ses_1", requestID: "per_1", reply: "sometimes" },
      }),
    ).toBeNull();
  });
});

describe("mapV2Event — tool lifecycle", () => {
  it("maps the doc-shaped tool.called fixture to tool.started", () => {
    // Fixture shape from docs/OPENCODE-CONTRACT.md (server v2.2.6).
    const event = mapV2Event({
      type: "session.tool.called",
      created: 1,
      data: { sessionID: "ses_1", assistantMessageID: "msg_a1", callID: "call_1", tool: "bash", title: "ls" },
    });
    expect(event).toEqual({
      kind: "tool.started",
      sessionID: "ses_1",
      callID: "call_1",
      tool: "bash",
      title: "ls",
      messageID: "msg_a1",
    });
  });

  it("maps the generated-types tool.called shape (id + input) to tool.input", () => {
    // Fixture shape from @opencode/client@2.3.2 types (server v2.3.x).
    const event = mapV2Event({
      type: "session.tool.called",
      data: { sessionID: "ses_1", assistantMessageID: "msg_a1", id: "call_2", input: { cmd: "ls" }, executed: true },
    });
    expect(event).toEqual({ kind: "tool.input", sessionID: "ses_1", callID: "call_2", input: { cmd: "ls" } });
  });

  it("maps tool.input.started (name) and tool.input.ended (JSON text)", () => {
    expect(
      mapV2Event({
        type: "session.tool.input.started",
        data: { sessionID: "ses_1", assistantMessageID: "msg_a1", id: "call_1", name: "read" },
      }),
    ).toEqual({
      kind: "tool.started",
      sessionID: "ses_1",
      callID: "call_1",
      tool: "read",
      title: undefined,
      messageID: "msg_a1",
    });
    expect(
      mapV2Event({
        type: "session.tool.input.ended",
        data: { sessionID: "ses_1", assistantMessageID: "msg_a1", id: "call_1", text: '{"path":"/a.ts"}' },
      }),
    ).toEqual({
      kind: "tool.input",
      sessionID: "ses_1",
      callID: "call_1",
      input: { path: "/a.ts" },
    });
  });

  it("maps progress and both completion flavors", () => {
    expect(
      mapV2Event({
        type: "session.tool.progress",
        data: { sessionID: "ses_1", callID: "call_1", output: "50%" },
      }),
    ).toEqual({ kind: "tool.progress", sessionID: "ses_1", callID: "call_1", output: "50%" });
    // Generated-types progress carries only metadata.
    expect(
      mapV2Event({
        type: "session.tool.progress",
        data: { sessionID: "ses_1", assistantMessageID: "msg_a1", id: "call_1", metadata: { rows: 3 } },
      }),
    ).toEqual({ kind: "tool.progress", sessionID: "ses_1", callID: "call_1", output: undefined });

    expect(
      mapV2Event({
        type: "session.tool.success",
        data: {
          sessionID: "ses_1",
          id: "call_1",
          content: [{ type: "text", text: "file body" }],
          metadata: { exit: 0 },
          executed: true,
        },
      }),
    ).toEqual({
      kind: "tool.completed",
      sessionID: "ses_1",
      callID: "call_1",
      status: "success",
      output: "file body",
      error: undefined,
      metadata: { exit: 0 },
    });
    expect(
      mapV2Event({
        type: "session.tool.failed",
        data: { sessionID: "ses_1", callID: "call_1", error: { type: "Sh", message: "boom" } },
      }),
    ).toEqual({
      kind: "tool.completed",
      sessionID: "ses_1",
      callID: "call_1",
      status: "error",
      output: undefined,
      error: "boom",
      metadata: undefined,
    });
  });
});

describe("mapV2Event — session lifecycle", () => {
  it("maps session.created (flat payload) to session.updated", () => {
    const event = mapV2Event({
      type: "session.created",
      created: 1_700_000_000_000,
      data: {
        sessionID: "ses_new",
        projectID: "p1",
        location: { directory: "/w" },
        slug: "new-chat",
        title: "New chat",
        agent: "build",
        model: { id: "claude-4", providerID: "anthropic" },
        version: "2.2.6",
      },
    });
    expect(event).toEqual({
      kind: "session.updated",
      session: {
        id: "ses_new",
        title: "New chat",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        model: { providerID: "anthropic", modelID: "claude-4", variant: undefined },
        agent: "build",
        cost: undefined,
      },
    });
  });

  it("maps session.renamed and session.deleted", () => {
    expect(
      mapV2Event({
        type: "session.renamed",
        created: 5,
        data: { sessionID: "ses_1", title: "Better title" },
      }),
    ).toEqual({
      kind: "session.updated",
      session: { id: "ses_1", title: "Better title", createdAt: 5, updatedAt: 5, model: undefined, agent: undefined, cost: undefined },
    });
    expect(mapV2Event({ type: "session.deleted", data: { sessionID: "ses_1" } })).toEqual({
      kind: "session.deleted",
      sessionID: "ses_1",
    });
  });

  it("folds usage into session.updated with the cost only", () => {
    const event = mapV2Event({
      type: "session.usage.updated",
      created: 9,
      data: { sessionID: "ses_1", cost: 0.42, tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } },
    });
    expect(event).toEqual({
      kind: "session.updated",
      session: { id: "ses_1", title: "", createdAt: 9, updatedAt: 9, cost: 0.42 },
    });
  });

  it("maps idle, execution outcomes, retry.scheduled and session.status", () => {
    expect(mapV2Event({ type: "session.idle", data: { sessionID: "ses_1" } })).toEqual({
      kind: "session.idle",
      sessionID: "ses_1",
    });
    expect(
      mapV2Event({
        type: "session.execution.failed",
        data: { sessionID: "ses_1", error: { type: "x", message: "quota exceeded" } },
      }),
    ).toEqual({ kind: "session.idle", sessionID: "ses_1", outcome: "failed", error: "quota exceeded" });
    expect(
      mapV2Event({
        type: "session.retry.scheduled",
        data: { sessionID: "ses_1", assistantMessageID: "m", attempt: 2, at: 99, error: { type: "x", message: "429" } },
      }),
    ).toEqual({ kind: "session.retry", sessionID: "ses_1", attempt: 2, message: "429" });
    expect(
      mapV2Event({ type: "session.status", data: { sessionID: "ses_1", status: { type: "retry", attempt: 3, message: " overloaded", next: 1 } } }),
    ).toEqual({ kind: "session.retry", sessionID: "ses_1", attempt: 3, message: " overloaded" });
    expect(mapV2Event({ type: "session.status", data: { sessionID: "ses_1", status: { type: "busy" } } })).toEqual({
      kind: "session.busy",
      sessionID: "ses_1",
      busy: true,
    });
    expect(mapV2Event({ type: "session.status", data: { sessionID: "ses_1", status: { type: "idle" } } })).toEqual({
      kind: "session.busy",
      sessionID: "ses_1",
      busy: false,
    });
  });

  it("maps filesystem, update and shutdown events", () => {
    expect(
      mapV2Event({ type: "filesystem.changed", data: { file: "/w/a.ts", event: "change" } }),
    ).toEqual({ kind: "file.changed", file: "/w/a.ts", change: "change" });
    expect(
      mapV2Event({ type: "installation.update-available", data: { version: "2.3.0" } }),
    ).toEqual({ kind: "update.available", version: "2.3.0" });
    expect(mapV2Event({ type: "location.shutdown", data: {} })).toEqual({ kind: "server.shutdown" });
  });
});

describe("mapV2Event — unknown and ignored", () => {
  it("flags unrecognized types as unknown", () => {
    expect(mapV2Event({ type: "totally.made.up", data: {} })).toEqual({
      kind: "unknown",
      type: "totally.made.up",
    });
  });

  it("returns null for known-but-ignored types", () => {
    expect(mapV2Event({ type: "server.connected", data: {} })).toBeNull();
    expect(mapV2Event({ type: "tui.toast.show", data: { message: "hi" } })).toBeNull();
    expect(mapV2Event({ type: "session.step.started", data: { sessionID: "s" } })).toBeNull();
  });
});

describe("parseV2Event", () => {
  it("passes well-formed events through", () => {
    const parsed = parseV2Event(envelope("session.text.delta", { sessionID: "s", assistantMessageID: "m", delta: "hi" }), silentLog);
    expect(parsed).toEqual({ kind: "text.delta", sessionID: "s", messageID: "m", delta: "hi" });
    expect(flattenEvents(parsed)).toHaveLength(1);
  });

  it("returns null (never throws) for malformed or unknown events", () => {
    expect(parseV2Event(null, silentLog)).toBeNull();
    expect(parseV2Event(42, silentLog)).toBeNull();
    expect(parseV2Event({}, silentLog)).toBeNull();
    expect(parseV2Event({ type: 123 }, silentLog)).toBeNull();
    expect(parseV2Event({ type: "nope.nope" }, silentLog)).toBeNull();
    // Objects that explode during validation must not throw either.
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(parseV2Event(circular, silentLog)).toBeNull();
  });

  it("flattens tool fan-out into a list", () => {
    const parsed = parseV2Event(
      envelope("session.tool.called", { sessionID: "s", id: "call_1", input: { a: 1 } }),
      silentLog,
    );
    expect(flattenEvents(parsed)).toEqual([{ kind: "tool.input", sessionID: "s", callID: "call_1", input: { a: 1 } }]);
  });
});

describe("helper projections", () => {
  it("permissionViewFromSdk applies defaults and redaction", () => {
    const view = permissionViewFromSdk(
      { id: "per_2", sessionID: "s", action: "edit", metadata: { apiKey: "sk-live-00000000000000" } },
      123,
    );
    expect(view).toMatchObject({ requestID: "per_2", sessionID: "s", action: "edit", title: "edit", askedAt: 123 });
    expect(view?.saveScopes).toEqual([]);
    expect(view?.resources).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("sk-live");
    expect(permissionViewFromSdk({ nope: true }, 1)).toBeNull();
  });

  it("maps Session.Info and tolerates missing fields", () => {
    const summary = sessionSummaryFromInfo({
      id: "ses_1",
      title: "T",
      agent: "build",
      model: { id: "claude-4", providerID: "anthropic", variant: "think" },
      cost: 0.5,
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 10, updated: 20, busy: 15 },
    });
    expect(summary).toEqual({
      id: "ses_1",
      title: "T",
      createdAt: 10,
      updatedAt: 20,
      model: { providerID: "anthropic", modelID: "claude-4", variant: "think" },
      agent: "build",
      cost: 0.5,
      busy: true,
    });
    expect(sessionSummaryFromInfo({})).toBeNull();
  });

  it("errorText and parseJsonish degrade gracefully", () => {
    expect(errorText("plain")).toBe("plain");
    expect(errorText({ message: "structured" })).toBe("structured");
    expect(errorText({ nope: 1 })).toBeUndefined();
    expect(parseJsonish('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonish("not json")).toBe("not json");
    expect(parseJsonish(5)).toBe(5);
  });
});

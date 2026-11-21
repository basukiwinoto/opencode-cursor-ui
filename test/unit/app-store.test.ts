import { describe, expect, it } from "vitest";
import { AppStore } from "../../src/state/appStore";
import type { NormalizedEvent } from "../../src/opencode/types";
import type { ChatMessage } from "../../shared/protocol";

const session = { id: "ses_1", title: "T", createdAt: 1, updatedAt: 1 };

function evt<T extends NormalizedEvent>(e: T): T {
  return e;
}

describe("AppStore", () => {
  it("creates assistant messages from text deltas and accumulates", () => {
    const store = new AppStore();
    store.applyEvent(evt({ kind: "text.started", sessionID: "ses_1", messageID: "m1" }));
    store.applyEvent(evt({ kind: "text.delta", sessionID: "ses_1", messageID: "m1", delta: "Hel" }));
    store.applyEvent(evt({ kind: "text.delta", sessionID: "ses_1", messageID: "m1", delta: "lo" }));
    const messages = store.getMessages("ses_1");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("Hello");
    expect(messages[0]?.streaming).toBe(true);
  });

  it("tracks tool lifecycle keyed by callID", () => {
    const store = new AppStore();
    store.applyEvent(evt({ kind: "text.started", sessionID: "s", messageID: "m1" }));
    store.applyEvent(evt({ kind: "tool.started", sessionID: "s", callID: "c1", tool: "edit", messageID: "m1" }));
    store.applyEvent(evt({ kind: "tool.input", sessionID: "s", callID: "c1", input: { file: "/x.ts" } }));
    store.applyEvent(evt({ kind: "tool.completed", sessionID: "s", callID: "c1", status: "success", output: "ok" }));
    const tools = store.getMessages("s")[0]?.tools ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ tool: "edit", status: "success", output: "ok", file: "/x.ts" });
  });

  it("does not duplicate tool.started events for the same call", () => {
    const store = new AppStore();
    store.applyEvent(evt({ kind: "text.started", sessionID: "s", messageID: "m1" }));
    store.applyEvent(evt({ kind: "tool.started", sessionID: "s", callID: "c1", tool: "bash", messageID: "m1" }));
    store.applyEvent(evt({ kind: "tool.started", sessionID: "s", callID: "c1", tool: "bash", messageID: "m1" }));
    expect(store.getMessages("s")[0]?.tools).toHaveLength(1);
  });

  it("accumulates reasoning separately from text", () => {
    const store = new AppStore();
    store.applyEvent(evt({ kind: "reasoning.delta", sessionID: "s", messageID: "m1", delta: "think" }));
    store.applyEvent(evt({ kind: "text.delta", sessionID: "s", messageID: "m1", delta: "answer" }));
    const message = store.getMessages("s")[0];
    expect(message?.reasoning).toBe("think");
    expect(message?.text).toBe("answer");
  });

  it("marks idle: streaming off and busy false", () => {
    const store = new AppStore();
    store.applyEvent(evt({ kind: "text.delta", sessionID: "s", messageID: "m1", delta: "x" }));
    expect(store.isBusy("s")).toBe(true);
    store.applyEvent(evt({ kind: "session.idle", sessionID: "s", outcome: "succeeded" }));
    expect(store.isBusy("s")).toBe(false);
    expect(store.getMessages("s")[0]?.streaming).toBe(false);
  });

  it("queues and resolves permissions", () => {
    const store = new AppStore();
    store.applyEvent(
      evt({
        kind: "permission.asked",
        request: {
          requestID: "p1",
          sessionID: "s",
          action: "bash",
          title: "Run command",
          resources: [],
          saveScopes: ["once", "always"],
          askedAt: 1,
        },
      }),
    );
    expect(store.listPermissions()).toHaveLength(1);
    const resolved = store.resolvePermission("p1");
    expect(resolved?.requestID).toBe("p1");
    expect(store.listPermissions()).toHaveLength(0);
    expect(store.resolvePermission("p1")).toBeUndefined();
  });

  it("maintains file changes per session and clears on session delete", () => {
    const store = new AppStore();
    store.setFileChanges("s", [{ file: "a.ts", patch: "", additions: 3, deletions: 1, status: "modified" }]);
    expect(store.getFileChanges()[0]?.additions).toBe(3);
    store.removeSession("s");
    expect(store.getFileChanges()).toHaveLength(0);
  });

  it("file.changed events mark status", () => {
    const store = new AppStore();
    store.applyEvent(evt({ kind: "file.changed", file: "b.ts", change: "add" }));
    expect(store.getFileChanges()[0]).toMatchObject({ path: "b.ts", status: "added" });
  });

  it("sessions sorted by updatedAt", () => {
    const store = new AppStore();
    store.upsertSession({ ...session, id: "a", updatedAt: 10 });
    store.upsertSession({ ...session, id: "b", updatedAt: 20 });
    expect(store.listSessions().map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("message.updated replaces by id", () => {
    const store = new AppStore();
    const base: ChatMessage = {
      id: "m1",
      role: "assistant",
      text: "one",
      tools: [],
      attachments: [],
      createdAt: 1,
      streaming: true,
    };
    store.applyEvent(evt({ kind: "message.started", sessionID: "s", message: base }));
    store.applyEvent(evt({ kind: "message.updated", sessionID: "s", message: { ...base, text: "one two" } }));
    const list = store.getMessages("s");
    expect(list).toHaveLength(1);
    expect(list[0]?.text).toBe("one two");
  });
});

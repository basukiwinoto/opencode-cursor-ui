import { describe, expect, it } from "vitest";
import { isHostToWebview, isWebviewToHost } from "../../shared/protocol";

describe("webview message validation", () => {
  it("accepts valid messages", () => {
    expect(isWebviewToHost({ type: "ready" })).toBe(true);
    expect(isWebviewToHost({ type: "sendMessage", text: "hi" })).toBe(true);
    expect(isWebviewToHost({ type: "sendMessage", text: "hi", files: [{ uri: "file:///a.ts" }] })).toBe(true);
    expect(isWebviewToHost({ type: "permissionReply", requestID: "r1", sessionID: "s1", decision: "once" })).toBe(true);
    expect(isWebviewToHost({ type: "selectModel", providerID: "anthropic", modelID: "claude" })).toBe(true);
    expect(isWebviewToHost({ type: "saveDraft", sessionID: null, text: "" })).toBe(true);
    expect(isWebviewToHost({ type: "navigate", view: "history" })).toBe(true);
    expect(isWebviewToHost({ type: "forkSession", sessionID: "s1", messageID: "m1" })).toBe(true);
    expect(isWebviewToHost({ type: "forkSession", sessionID: "s1" })).toBe(true);
    expect(isWebviewToHost({ type: "forkSession", messageID: "m1" })).toBe(false);
    expect(isWebviewToHost({ type: "openFile", path: "/a.ts", line: 3 })).toBe(true);
  });

  it("rejects malformed messages", () => {
    expect(isWebviewToHost(null)).toBe(false);
    expect(isWebviewToHost("ready")).toBe(false);
    expect(isWebviewToHost({})).toBe(false);
    expect(isWebviewToHost({ type: "unknown-command" })).toBe(false);
    expect(isWebviewToHost({ type: "sendMessage" })).toBe(false);
    expect(isWebviewToHost({ type: "sendMessage", text: 42 })).toBe(false);
    expect(isWebviewToHost({ type: "permissionReply", requestID: "r" })).toBe(false);
    expect(isWebviewToHost({ type: "permissionReply", requestID: "r", sessionID: "s", decision: "maybe" })).toBe(false);
    expect(isWebviewToHost({ type: "renameSession", sessionID: "s" })).toBe(false);
    expect(isWebviewToHost({ type: "connectExternal", url: "javascript:alert(1)" })).toBe(false);
    expect(isWebviewToHost({ type: "openFile", path: 1 })).toBe(false);
    expect(isWebviewToHost({ type: "navigate", view: "admin" })).toBe(false);
  });

  it("validates host→webview messages", () => {
    expect(isHostToWebview({ type: "error", message: "boom" })).toBe(true);
    expect(isHostToWebview({ type: "state", state: { view: "chat" } })).toBe(true);
    expect(isHostToWebview({ type: "nonsense" })).toBe(false);
    expect(isHostToWebview(42)).toBe(false);
  });
});

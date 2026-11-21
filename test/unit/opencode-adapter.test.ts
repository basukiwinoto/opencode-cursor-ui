import { afterEach, describe, expect, it, vi } from "vitest";
import type { Log } from "../../src/core/logger";
import { OpenCodeClientAdapter, OpenCodeAdapterError } from "../../src/opencode/adapter";
import type { OpenCodeClientLike, SdkRequestOptions } from "../../src/opencode/adapter";
import type { EventSubscribeInput } from "@opencode/client";
import type { ConnectionStatus } from "../../src/opencode/types";

const silentLog: Log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const fakeHeaders = async () => ({ authorization: "Basic dGVzdC1vbmx5LXRva2Vu" });

function hangUntilAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

/** SSE stream stub: one guaranteed first event, then hangs until aborted. */
function fakeStream(signal?: AbortSignal): AsyncIterable<unknown> {
  return (async function* () {
    yield { id: "evt_0", created: Date.now(), type: "server.connected", data: {} };
    await hangUntilAbort(signal);
  })();
}

function makeFakeClient() {
  const unexpected = (method: string) => async (): Promise<never> => {
    throw new Error(`unexpected call: ${method}`);
  };
  return {
    server: {
      info: vi.fn(async () => ({ version: "2.2.6", pid: 4321, hostname: "local", urls: [], paths: { tmp: "/tmp" } })),
    },
    session: {
      list: vi.fn(async () => ({ data: [], cursor: {} })),
      create: vi.fn(unexpected("session.create")),
      get: vi.fn(unexpected("session.get")),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      prompt: vi.fn(unexpected("session.prompt")),
      interrupt: vi.fn(async () => ({ interrupted: true })),
      switchModel: vi.fn(unexpected("session.switchModel")),
      diff: vi.fn(unexpected("session.diff")),
    },
    message: { list: vi.fn(async () => ({ data: [], cursor: {} })) },
    agent: { list: vi.fn(async () => ({ data: [] })) },
    provider: { list: vi.fn(async () => ({ data: [] })) },
    model: { list: vi.fn(async () => ({ data: [] })), default: vi.fn(async () => ({ data: null })) },
    permission: {
      request: { list: vi.fn(async () => ({ data: [] })) },
      reply: vi.fn(async () => undefined),
    },
    event: {
      subscribe: vi.fn(
        (_input?: EventSubscribeInput, requestOptions?: SdkRequestOptions): AsyncIterable<unknown> =>
          fakeStream(requestOptions?.signal),
      ),
    },
  };
}

type FakeClient = ReturnType<typeof makeFakeClient>;

function makeAdapter(client: FakeClient, extra?: { eventSignal?: AbortSignal }): OpenCodeClientAdapter {
  return new OpenCodeClientAdapter({
    baseUrl: "http://127.0.0.1:4096/",
    getHeaders: fakeHeaders,
    logger: silentLog,
    clientFactory: () => client as OpenCodeClientLike,
    reconnect: { initialDelayMs: 1, maxDelayMs: 8 },
    ...extra,
  });
}

function dedupe(states: string[]): string[] {
  return states.filter((state, index) => index === 0 || state !== states[index - 1]);
}

const disposed: OpenCodeClientAdapter[] = [];
function tracked(adapter: OpenCodeClientAdapter): OpenCodeClientAdapter {
  disposed.push(adapter);
  return adapter;
}

afterEach(() => {
  for (const adapter of disposed.splice(0)) adapter.dispose();
});

describe("OpenCodeClientAdapter.connect", () => {
  it("verifies the server and reaches connected state", async () => {
    const client = makeFakeClient();
    const getHeaders = vi.fn(fakeHeaders);
    const adapter = tracked(
      new OpenCodeClientAdapter({
        baseUrl: "http://127.0.0.1:4096",
        getHeaders,
        logger: silentLog,
        clientFactory: () => client as OpenCodeClientLike,
      }),
    );
    await adapter.connect();
    expect(adapter.connection).toMatchObject({ state: "connected", serverUrl: "http://127.0.0.1:4096" });
    expect(getHeaders).toHaveBeenCalledTimes(1);
    expect(client.server.info).toHaveBeenCalledTimes(1);
    expect(await adapter.serverInfo()).toEqual({ version: "2.2.6", pid: 4321 });
  });

  it("maps a 401 into an actionable authentication error", async () => {
    const client = makeFakeClient();
    client.server.info.mockRejectedValueOnce({ _tag: "UnauthorizedError", message: "Authentication required" });
    const adapter = tracked(makeAdapter(client));
    const error = await adapter.connect().then(
      () => {
        throw new Error("connect should have failed");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OpenCodeAdapterError);
    expect((error as OpenCodeAdapterError).message).toContain("authentication failed: check server password");
    expect((error as OpenCodeAdapterError).tag).toBe("UnauthorizedError");
    expect(adapter.connection.state).toBe("disconnected");
    expect(adapter.connection.error).toContain("authentication failed");
  });

  it("preserves the SessionBusyError tag from SDK errors", async () => {
    const client = makeFakeClient();
    const adapter = tracked(makeAdapter(client));
    await adapter.connect();
    (client.session.prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      _tag: "SessionBusyError",
      sessionID: "ses_1",
      message: "session is already running",
    });
    const error = await adapter.prompt({ sessionID: "ses_1", text: "hi" }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OpenCodeAdapterError);
    expect((error as OpenCodeAdapterError).tag).toBe("SessionBusyError");
    expect((error as OpenCodeAdapterError).message).toContain("session is busy");
  });
});

describe("OpenCodeClientAdapter.listMessages", () => {
  it("maps user and assistant messages, tools and usage", async () => {
    const client = makeFakeClient();
    const adapter = tracked(makeAdapter(client));
    await adapter.connect();
    (client.message.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: [
        {
          id: "msg_u1",
          type: "user",
          text: "fix the bug",
          time: { created: 1_000 },
          files: [{ name: "a.ts", mime: "text/plain", data: "", source: { type: "uri", uri: "file:///w/a.ts" } }],
        },
        {
          id: "msg_sys1",
          type: "system",
          text: "ignored",
          time: { created: 1_100 },
        },
        {
          id: "msg_a1",
          type: "assistant",
          agent: "build",
          model: { id: "claude-4", providerID: "anthropic" },
          cost: 0.02,
          tokens: { input: 10, output: 20, reasoning: 1, cache: { read: 5, write: 6 } },
          time: { created: 2_000, completed: 3_000 },
          content: [
            { type: "reasoning", text: "thinking hard" },
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
            {
              type: "tool",
              id: "call_1",
              name: "read",
              state: {
                status: "completed",
                input: { path: "/w/a.ts" },
                content: [{ type: "text", text: "file body" }],
              },
              time: { created: 2_100, completed: 2_500 },
            },
            {
              type: "tool",
              id: "call_2",
              name: "bash",
              state: { status: "streaming", input: '{"command":"ls' },
              time: { created: 2_600 },
            },
          ],
        },
        {
          id: "msg_a2",
          type: "assistant",
          agent: "build",
          model: { id: "claude-4", providerID: "anthropic" },
          time: { created: 4_000 },
          content: [{ type: "text", text: "still typing…" }],
        },
      ],
      cursor: {},
    });
    const messages = await adapter.listMessages("ses_1");
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      id: "msg_u1",
      role: "user",
      text: "fix the bug",
      streaming: false,
      attachments: [{ name: "a.ts", uri: "file:///w/a.ts", kind: "file" }],
    });
    const assistant = messages[1];
    expect(assistant).toMatchObject({
      id: "msg_a1",
      role: "assistant",
      text: "hello world",
      reasoning: "thinking hard",
      streaming: false,
      cost: 0.02,
      model: { providerID: "anthropic", modelID: "claude-4" },
      tokens: { input: 10, output: 20, reasoning: 1, cacheRead: 5, cacheWrite: 6 },
      createdAt: 2_000,
      updatedAt: 3_000,
    });
    expect(assistant?.tools).toEqual([
      {
        callID: "call_1",
        tool: "read",
        title: undefined,
        status: "success",
        input: { path: "/w/a.ts" },
        output: "file body",
        error: undefined,
        file: undefined,
        startedAt: 2_100,
        finishedAt: 2_500,
      },
      {
        callID: "call_2",
        tool: "bash",
        title: undefined,
        status: "running", // "streaming" maps to running
        input: '{"command":"ls', // unparseable partial JSON stays a string
        output: undefined,
        error: undefined,
        file: undefined,
        startedAt: 2_600,
        finishedAt: undefined,
      },
    ]);
    expect(messages[2]?.streaming).toBe(true);
  });
});

describe("OpenCodeClientAdapter.prompt", () => {
  it("switches the model first and forwards files", async () => {
    const client = makeFakeClient();
    const adapter = tracked(makeAdapter(client));
    await adapter.connect();
    client.session.switchModel.mockResolvedValue(undefined);
    (client.session.prompt as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "msg_u1",
      type: "user",
      text: "hi",
      time: { created: 1 },
    });
    await adapter.prompt({
      sessionID: "ses_1",
      text: "hello",
      files: [{ uri: "file:///w/a.ts", name: "a.ts" }],
      model: { providerID: "anthropic", modelID: "claude-4", variant: "think" },
    });
    expect(client.session.switchModel).toHaveBeenCalledWith({
      sessionID: "ses_1",
      model: { id: "claude-4", providerID: "anthropic", variant: "think" },
    });
    expect(client.session.prompt).toHaveBeenCalledWith({
      sessionID: "ses_1",
      text: "hello",
      files: [{ uri: "file:///w/a.ts", name: "a.ts" }],
    });
    expect(client.session.switchModel.mock.invocationCallOrder[0]).toBeLessThan(
      client.session.prompt.mock.invocationCallOrder[0],
    );
  });

  it("skips the model switch when no model is requested", async () => {
    const client = makeFakeClient();
    const adapter = tracked(makeAdapter(client));
    await adapter.connect();
    (client.session.prompt as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "msg_u1",
      type: "user",
      text: "hi",
      time: { created: 1 },
    });
    await adapter.prompt({ sessionID: "ses_1", text: "hello" });
    expect(client.session.switchModel).not.toHaveBeenCalled();
    expect(client.session.prompt).toHaveBeenCalledWith({ sessionID: "ses_1", text: "hello", files: undefined });
  });
});

describe("OpenCodeClientAdapter.permissions", () => {
  it("forwards the decision to permission.reply", async () => {
    const client = makeFakeClient();
    const adapter = tracked(makeAdapter(client));
    await adapter.connect();
    await adapter.replyPermission("ses_1", "per_1", "always", "trusted");
    expect(client.permission.reply).toHaveBeenCalledWith({
      sessionID: "ses_1",
      requestID: "per_1",
      decision: "always",
      message: "trusted",
    });
  });

  it("lists pending permissions with saveScopes and redacted metadata", async () => {
    const client = makeFakeClient();
    const adapter = tracked(makeAdapter(client));
    await adapter.connect();
    (client.permission.request.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        {
          id: "per_1",
          sessionID: "ses_1",
          action: "bash",
          resources: ["/tmp/install.sh"],
          save: ["once", "always"],
          metadata: { apiKey: "sk-live-000000000000000000", command: "install.sh" },
        },
        { nope: true },
      ],
    });
    const views = await adapter.listPendingPermissions();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      requestID: "per_1",
      sessionID: "ses_1",
      action: "bash",
      title: "bash",
      resources: ["/tmp/install.sh"],
      saveScopes: ["once", "always"],
    });
    expect(JSON.stringify(views)).not.toContain("sk-live");
    expect((views[0]?.metadata as Record<string, unknown>)["command"]).toBe("install.sh");
  });
});

describe("OpenCodeClientAdapter catalog", () => {
  it("redacts models/providers and extracts the default model", async () => {
    const client = makeFakeClient();
    const adapter = tracked(makeAdapter(client));
    await adapter.connect();
    (client.model.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      location: { directory: "/w" },
      data: [
        {
          id: "anthropic/claude-4",
          modelID: "claude-4",
          providerID: "anthropic",
          name: "Claude 4",
          family: "claude",
          type: "chat",
          settings: { apiKey: "sk-live-000000000000000000", baseURL: "https://api.anthropic.com" },
        },
        { providerID: "anthropic" }, // invalid — dropped
      ],
    });
    (client.provider.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      location: { directory: "/w" },
      data: [{ id: "anthropic", name: "Anthropic", activation: "enabled", settings: { apiKey: "sk-live-000000000000000000" } }],
    });
    (client.model.default as ReturnType<typeof vi.fn>).mockResolvedValue({
      location: { directory: "/w" },
      data: { modelID: "claude-4", providerID: "anthropic", name: "Claude 4", settings: { apiKey: "sk-live-000000000000000000" } },
    });
    const catalog = await adapter.listModels();
    expect(catalog.models).toEqual([
      { providerID: "anthropic", modelID: "claude-4", label: "Claude 4", family: "claude", type: "chat" },
    ]);
    expect(catalog.providers).toEqual([{ id: "anthropic", name: "Anthropic", activation: "enabled", modelCount: 1 }]);
    expect(catalog.defaultModel).toEqual({ providerID: "anthropic", modelID: "claude-4" });
    expect(JSON.stringify(catalog)).not.toContain("sk-live");
  });

  it("tolerates a failing model.default", async () => {
    const client = makeFakeClient();
    const adapter = tracked(makeAdapter(client));
    await adapter.connect();
    (client.model.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ modelID: "claude-4", providerID: "anthropic", name: "Claude 4" }],
    });
    (client.model.default as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      _tag: "UnknownError",
      message: "nope",
    });
    const catalog = await adapter.listModels();
    expect(catalog.models).toHaveLength(1);
    expect(catalog.defaultModel).toBeUndefined();
    expect(silentLog.warn).toHaveBeenCalled();
  });

  it("lists non-hidden agents", async () => {
    const client = makeFakeClient();
    const adapter = tracked(makeAdapter(client));
    await adapter.connect();
    (client.agent.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        { id: "build", name: "Build", mode: "primary", hidden: false, permissions: [] },
        { id: "general", name: "General", mode: "subagent", hidden: true, permissions: [] },
      ],
    });
    const agents = await adapter.listAgents();
    expect(agents).toEqual([{ id: "build", name: "Build", description: undefined }]);
  });

  it("maps session diffs as-is", async () => {
    const client = makeFakeClient();
    const adapter = tracked(makeAdapter(client));
    await adapter.connect();
    (client.session.diff as ReturnType<typeof vi.fn>).mockResolvedValue([
      { file: "src/a.ts", patch: "--- a\n+++ b\n", additions: 3, deletions: 1, status: "modified" },
    ]);
    expect(await adapter.sessionDiff("ses_1")).toEqual([
      { file: "src/a.ts", patch: "--- a\n+++ b\n", additions: 3, deletions: 1, status: "modified" },
    ]);
  });

  it("maps sessions and returns undefined for missing ones", async () => {
    const client = makeFakeClient();
    const adapter = tracked(makeAdapter(client));
    await adapter.connect();
    (client.session.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        {
          id: "ses_1",
          projectID: "p1",
          title: "Chat",
          agent: "build",
          cost: 0.1,
          time: { created: 10, updated: 20 },
        },
        { nope: true },
      ],
      cursor: {},
    });
    expect(await adapter.listSessions()).toEqual([
      {
        id: "ses_1",
        title: "Chat",
        createdAt: 10,
        updatedAt: 20,
        model: undefined,
        agent: "build",
        cost: 0.1,
        busy: undefined,
      },
    ]);
    (client.session.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      _tag: "SessionNotFoundError",
      sessionID: "ses_x",
      message: "not found",
    });
    expect(await adapter.getSession("ses_x")).toBeUndefined();
  });
});

describe("OpenCodeClientAdapter.event pump", () => {
  it("reconnects after a subscribe failure and re-emits normalized events", async () => {
    const client = makeFakeClient();
    const adapter = tracked(makeAdapter(client));
    const states: string[] = [];
    adapter.onConnectionChange.subscribe((status) => states.push(status.state));
    const received: string[] = [];
    adapter.onEvent.subscribe((event) => received.push(event.kind));

    // First subscribe attempt throws; the second delivers a real event.
    (client.event.subscribe as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("socket boom");
    });
    (client.event.subscribe as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_input?: EventSubscribeInput, requestOptions?: SdkRequestOptions): AsyncIterable<unknown> =>
        (async function* () {
          yield { id: "evt_0", created: Date.now(), type: "server.connected", data: {} };
          yield {
            id: "evt_1",
            created: Date.now(),
            type: "session.text.delta",
            data: { sessionID: "ses_1", assistantMessageID: "msg_a1", delta: "hi" },
          };
          await hangUntilAbort(requestOptions?.signal);
        })(),
    );

    await adapter.connect();
    await vi.waitFor(() => {
      expect(client.event.subscribe.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(adapter.connection.state).toBe("connected");
    });
    expect(dedupe(states)).toEqual(["connecting", "connected", "reconnecting", "connected"]);
    await vi.waitFor(() => expect(received).toContain("text.delta"));
  });

  it("dispose stops the pump for good", async () => {
    const client = makeFakeClient();
    const adapter = tracked(makeAdapter(client));
    await adapter.connect();
    await vi.waitFor(() => expect(client.event.subscribe.mock.calls.length).toBe(1));
    adapter.dispose();
    expect(adapter.connection.state).toBe("disconnected");
    const calls = client.event.subscribe.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(client.event.subscribe.mock.calls.length).toBe(calls);
    await expect(adapter.connect()).rejects.toThrow(/disposed/);
  });

  it("stops the pump when the external eventSignal is already aborted", async () => {
    const client = makeFakeClient();
    const controller = new AbortController();
    controller.abort();
    const adapter = tracked(makeAdapter(client, { eventSignal: controller.signal }));
    await adapter.connect();
    expect(adapter.connection.state).toBe("connected");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.event.subscribe).not.toHaveBeenCalled();
  });
});

describe("OpenCodeClientAdapter.not connected", () => {
  it("rejects queries before connect() with an actionable error", async () => {
    const adapter = tracked(makeAdapter(makeFakeClient()));
    await expect(adapter.listSessions()).rejects.toThrow(/not connected/);
    expect(await adapter.serverInfo()).toBeUndefined();
  });
});

describe("OpenCodeClientAdapter.forkSession", () => {
  it("calls session.fork with the message id and maps the forked session", async () => {
    const client = makeFakeClient();
    client.session.fork = vi.fn(async () => ({
      data: {
        id: "ses_fork1",
        projectID: "proj",
        title: "Forked chat",
        time: { created: 1000, updated: 2000 },
        location: { directory: "/w" },
      },
    }));
    const adapter = tracked(makeAdapter(client));
    await adapter.connect();
    const summary = await adapter.forkSession("ses_orig", "msg_9");
    expect(client.session.fork).toHaveBeenCalledWith({ sessionID: "ses_orig", before: "msg_9" });
    expect(summary).toMatchObject({ id: "ses_fork1", title: "Forked chat" });
  });

  it("forks the whole session when no message id is given", async () => {
    const client = makeFakeClient();
    client.session.fork = vi.fn(async () => ({
      data: { id: "ses_fork2", projectID: "proj", title: "Whole", time: { created: 1, updated: 2 }, location: { directory: "/w" } },
    }));
    const adapter = tracked(makeAdapter(client));
    await adapter.connect();
    await adapter.forkSession("ses_orig");
    expect(client.session.fork).toHaveBeenCalledWith({ sessionID: "ses_orig", before: undefined });
  });
});

describe("connection status type", () => {
  it("keeps the declared shape", () => {
    const status: ConnectionStatus = { state: "reconnecting", serverUrl: "http://x", error: "boom" };
    expect(status.state).toBe("reconnecting");
  });
});

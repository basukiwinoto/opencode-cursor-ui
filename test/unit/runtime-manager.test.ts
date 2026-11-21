import { beforeEach, describe, expect, it, vi } from "vitest";
import { Service } from "@opencode/client/service";
import {
  RuntimeManager,
  RuntimeStartError,
  StopRefusedError,
} from "../../src/runtime/runtimeManager";
import type { RuntimeManagerOptions, RuntimeSettingsShape } from "../../src/runtime/runtimeManager";
import type { RuntimeState } from "../../shared/protocol";
import { FakeChild, FakeLogger, flushMicrotasks, jsonResponse, spawnScript, statusResponse } from "./runtime/helpers";

vi.mock("@opencode/client/service", () => ({
  Service: {
    discover: vi.fn(),
    ensure: vi.fn(),
    stop: vi.fn(),
    headers: vi.fn(),
  },
}));

const PASSWORD = "tok_secret_abc123";

interface SpawnCallRecord {
  command: string;
  args: readonly string[];
  options?: { cwd?: string };
}

interface ManagerFixture {
  manager: RuntimeManager;
  calls: SpawnCallRecord[];
  logger: FakeLogger;
  states: RuntimeState[];
  fetchCalls: Array<{ url: string; init?: RequestInit }>;
}

function okFetch(calls: Array<{ url: string; init?: RequestInit }>, body: unknown = { version: "2.2.6" }): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse(body);
  }) as typeof fetch;
}

function createFixture(options: {
  children?: FakeChild[];
  fetchFn?: typeof fetch;
  settings?: Partial<RuntimeSettingsShape>;
  managerOptions?: Partial<RuntimeManagerOptions>;
}): ManagerFixture {
  const logger = new FakeLogger();
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const states: RuntimeState[] = [];
  let port = 4711;
  const { spawnFn, calls } = spawnScript(options.children ?? []);
  const manager = new RuntimeManager({
    logger,
    spawnFn,
    fetchFn: options.fetchFn ?? okFetch(fetchCalls),
    freePortFn: async () => {
      port += 1;
      return port;
    },
    getSettings: () => ({
      runtimeMode: "managed",
      executablePath: "/fake/opencode",
      startupTimeoutMs: 2_000,
      externalServerUrl: "",
      ...(options.settings ?? {}),
    }),
    startupPollMs: 25,
    stopGraceMs: 50,
    reconnect: { baseDelayMs: 50, maxDelayMs: 400, maxAttempts: 5 },
    ...(options.managerOptions ?? {}),
  });
  manager.onStateChange((state) => states.push(state));
  return { manager, calls: calls as SpawnCallRecord[], logger, states, fetchCalls };
}

/** Starts the manager and feeds the child the two verified startup lines once its listeners exist. */
async function startHealthy(fixture: ManagerFixture, child: FakeChild, port = 4712): Promise<void> {
  const started = fixture.manager.start({ workspaceRoot: "/ws" });
  await flushMicrotasks(); // the spawn (and its stdout listeners) happen within a few microtasks
  child.writeLine(`server listening on http://127.0.0.1:${port}`);
  child.writeLine(`server password ${PASSWORD}`);
  await started;
}

describe("RuntimeManager (managed)", () => {
  beforeEach(() => {
    vi.mocked(Service.discover).mockReset();
    vi.mocked(Service.stop).mockReset();
  });

  it("starts the server, captures the url and password, and reports running", async () => {
    const child = new FakeChild();
    const fixture = createFixture({ children: [child] });
    await startHealthy(fixture, child);

    expect(fixture.manager.getState()).toBe("running");
    expect(fixture.calls[0]?.command).toBe("/fake/opencode");
    expect(fixture.calls[0]?.args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "4712"]);
    expect(fixture.calls[0]?.options?.cwd).toBe("/ws");
    expect(fixture.manager.getServerUrl()).toBe("http://127.0.0.1:4712");
    expect(fixture.manager.managedInfo()).toMatchObject({
      executablePath: "/fake/opencode",
      port: 4712,
      serverUrl: "http://127.0.0.1:4712",
      pid: 4242,
    });
    const headers = await fixture.manager.getAuthHeaders();
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`);
  });

  it("uses 'opencode' from PATH when no executable is configured", async () => {
    const child = new FakeChild();
    const fixture = createFixture({ children: [child], settings: { executablePath: "" } });
    await startHealthy(fixture, child);
    expect(fixture.calls[0]?.command).toBe("opencode");
  });

  it("never exposes the password via managedInfo(), toString(), or the logger", async () => {
    const child = new FakeChild();
    const fixture = createFixture({ children: [child] });
    await startHealthy(fixture, child);
    expect(JSON.stringify(fixture.manager.managedInfo())).not.toContain(PASSWORD);
    expect(fixture.manager.toString()).not.toContain(PASSWORD);
    expect(fixture.logger.allText()).not.toContain(PASSWORD);
  });

  it("scrubs the password out of startup stderr in error messages", async () => {
    const child = new FakeChild();
    const fixture = createFixture({ children: [child] });
    const started = fixture.manager.start({ workspaceRoot: "/ws" }).catch((error: unknown) => error);
    await flushMicrotasks(); // spawn + listeners attached
    // The password line arrives on stdout (captured for auth), then the
    // server dies with the token echoed in stderr — the surfaced error must
    // redact it.
    child.writeLine(`server password ${PASSWORD}`);
    child.writeLine(`crash: password ${PASSWORD} leaked`, "stderr");
    await flushMicrotasks(); // let the stdout parser capture the password
    child.emitExit(1, null);
    const error = (await started) as Error;
    expect(error).toBeInstanceOf(RuntimeStartError);
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain(PASSWORD);
    expect(fixture.manager.getState()).toBe("error");
    expect(fixture.logger.allText()).not.toContain(PASSWORD);
  });

  it("transitions to error and tears the process down when the server never becomes healthy", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      child.autoExitOn = ["SIGKILL"];
      const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        return statusResponse(503);
      }) as typeof fetch;
      const fixture = createFixture({ children: [child], fetchFn });
      const failure = fixture.manager.start({ workspaceRoot: "/ws" }).catch((error: unknown) => error);
      await flushMicrotasks();
      child.writeLine("server listening on http://127.0.0.1:4712");
      child.writeLine(`server password ${PASSWORD}`);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(3_000);
      const error = (await failure) as Error;
      expect(error).toBeInstanceOf(RuntimeStartError);
      expect(error.message).toContain("did not become healthy");
      expect(fixture.manager.getState()).toBe("error");
      expect(child.signals).toContain("SIGTERM");
      expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:4712/api/info");
      expect(fetchCalls[0]?.init?.headers).toMatchObject({ Authorization: expect.any(String) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("enters reconnecting and restarts with exponential backoff after an unexpected exit", async () => {
    vi.useFakeTimers();
    try {
      const first = new FakeChild();
      const second = new FakeChild();
      const third = new FakeChild();
      const fixture = createFixture({ children: [first, second, third] });
      await startHealthy(fixture, first, 4712);
      // Pre-buffer the startup lines for the restart attempts (delivered on attach).
      second.writeLine("server listening on http://127.0.0.1:4713");
      second.writeLine(`server password ${PASSWORD}`);
      third.writeLine("server listening on http://127.0.0.1:4714");
      third.writeLine(`server password ${PASSWORD}`);

      first.emitExit(1, null);
      expect(fixture.manager.getState()).toBe("reconnecting");
      expect(fixture.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(49); // first backoff is baseDelayMs (50)
      expect(fixture.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.calls).toHaveLength(2);
      expect(fixture.manager.getState()).toBe("running");
      expect(fixture.calls[1]?.args[4]).toBe("4713");

      // A successful restart resets the backoff; the next crash waits the
      // base delay again. (Exponential growth applies to consecutive FAILED
      // attempts — covered by the maxAttempts test.)
      second.emitExit(1, null);
      expect(fixture.manager.getState()).toBe("reconnecting");
      await vi.advanceTimersByTimeAsync(49);
      expect(fixture.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.calls).toHaveLength(3);
      expect(fixture.manager.getState()).toBe("running");
      expect(fixture.calls[2]?.args[4]).toBe("4714");
    } finally {
      vi.useRealTimers();
    }
  });

  it("grows the backoff across consecutive failed attempts", async () => {
    vi.useFakeTimers();
    try {
      const first = new FakeChild();
      const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
      const fixture = createFixture({
        children: [first],
        managerOptions: {
          reconnect: { baseDelayMs: 20, maxDelayMs: 1_000, maxAttempts: 5 },
          fetchFn: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            fetchCalls.push({ url: String(input), init });
            // Only the initial server on 4712 is healthy; every attempt probes a dead port.
            return String(input).includes("4712") ? jsonResponse({ version: "2.2.6" }) : statusResponse(503);
          }) as typeof fetch,
        },
      });
      await startHealthy(fixture, first, 4712);
      first.emitExit(1, null);
      // Attempt 1 after 20ms; attempt 2 after 20 + 40 (doubled); attempt 3 after +80.
      await vi.advanceTimersByTimeAsync(20);
      expect(fixture.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(40);
      expect(fixture.calls).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(79);
      expect(fixture.calls).toHaveLength(3); // third delay is 80ms — not elapsed
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.calls).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after maxAttempts and reports the error state", async () => {
    vi.useFakeTimers();
    try {
      const first = new FakeChild();
      const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        return statusResponse(503); // every probe fails after the initial start
      }) as typeof fetch;
      const fixture = createFixture({
        children: [first],
        managerOptions: {
          reconnect: { baseDelayMs: 10, maxDelayMs: 100, maxAttempts: 2 },
          // Healthy only for the initial server on port 4712; the reconnect
          // attempts (new ports) probe a dead server.
          fetchFn: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            fetchCalls.push({ url: String(input), init });
            return String(input).includes("4712") ? jsonResponse({ version: "2.2.6" }) : statusResponse(503);
          }) as typeof fetch,
        },
      });
      await startHealthy(fixture, first, 4712);
      first.emitExit(1, null);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fixture.manager.getState()).toBe("error");
      // 1 initial spawn + 2 reconnect attempts (fallback children exit instantly).
      expect(fixture.calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("stop lifecycle", () => {
    it("sends SIGTERM and stops gracefully when the process exits", async () => {
      const child = new FakeChild();
      child.autoExitOn = ["SIGTERM"];
      const fixture = createFixture({ children: [child] });
      await startHealthy(fixture, child);

      await fixture.manager.stop();
      expect(child.signals).toEqual(["SIGTERM"]);
      expect(fixture.manager.getState()).toBe("stopped");
      expect(fixture.manager.getServerUrl()).toBeUndefined();
      expect(fixture.manager.managedInfo()).toBeUndefined();
      const headers = await fixture.manager.getAuthHeaders();
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("escalates to SIGKILL after the grace period", async () => {
      vi.useFakeTimers();
      try {
        const child = new FakeChild(); // ignores SIGTERM, like a wedged process
        const fixture = createFixture({ children: [child] });
        await startHealthy(fixture, child);

        const stopped = fixture.manager.stop().catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(2_000);
        const error = await stopped;
        expect(error).toBeUndefined();
        expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(fixture.manager.getState()).toBe("stopped");
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses to stop while the busy-guard declines, then stops once it allows", async () => {
      const child = new FakeChild();
      child.autoExitOn = ["SIGTERM"];
      let allowStop = false;
      const fixture = createFixture({
        children: [child],
        managerOptions: { shouldStop: async () => allowStop },
      });
      await startHealthy(fixture, child);

      const error = await fixture.manager.stop().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(StopRefusedError);
      expect(fixture.manager.getState()).toBe("running");
      expect(child.signals).toEqual([]);

      allowStop = true;
      await fixture.manager.stop();
      expect(fixture.manager.getState()).toBe("stopped");
      expect(child.signals).toEqual(["SIGTERM"]);
    });
  });

  it("restarts (stop + start) with the new workspace root", async () => {
    const first = new FakeChild();
    first.autoExitOn = ["SIGTERM"];
    const second = new FakeChild();
    const fixture = createFixture({ children: [first, second] });
    await startHealthy(fixture, first, 4712);

    const restarted = fixture.manager.restart("/ws2");
    await flushMicrotasks(); // the new spawn happens inside restart
    second.writeLine("server listening on http://127.0.0.1:4713");
    second.writeLine(`server password ${PASSWORD}`);
    await restarted;

    expect(fixture.manager.getState()).toBe("running");
    expect(fixture.calls[0]?.options?.cwd).toBe("/ws");
    expect(fixture.calls[1]?.options?.cwd).toBe("/ws2");
    expect(first.signals).toEqual(["SIGTERM"]);
  });

  it("delegates start() to connectExternal when settings select external mode", async () => {
    const fixture = createFixture({
      settings: { runtimeMode: "external", externalServerUrl: "http://127.0.0.1:6000" },
    });
    await fixture.manager.start({});
    expect(fixture.manager.getState()).toBe("running");
    expect(fixture.manager.getMode()).toBe("external");
    expect(fixture.calls).toHaveLength(0);
    expect(vi.mocked(Service.discover)).not.toHaveBeenCalled();
    expect(fixture.fetchCalls[0]?.url).toBe("http://127.0.0.1:6000/api/info");
  });

  it("disposes: stops the server and detaches listeners", async () => {
    const child = new FakeChild();
    child.autoExitOn = ["SIGTERM"];
    const fixture = createFixture({ children: [child] });
    await startHealthy(fixture, child);
    await fixture.manager.dispose();
    expect(fixture.manager.getState()).toBe("stopped");
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("reports state changes to subscribers with an unsubscribe handle", async () => {
    const child = new FakeChild();
    const fixture = createFixture({ children: [child] });
    const seen: RuntimeState[] = [];
    const unsubscribe = fixture.manager.onStateChange((state) => seen.push(state));
    await startHealthy(fixture, child, 4712);
    expect(seen).toContain("starting");
    expect(seen).toContain("running");
    expect(typeof unsubscribe).toBe("function");
    expect(typeof unsubscribe.dispose).toBe("function");
    unsubscribe();
    child.emitExit(1, null);
    expect(seen).not.toContain("reconnecting"); // listener detached
  });
});

describe("RuntimeManager (external)", () => {
  beforeEach(() => {
    vi.mocked(Service.discover).mockReset();
    vi.mocked(Service.stop).mockReset();
  });

  it("discovers the shared local service via @opencode/client", async () => {
    vi.mocked(Service.discover).mockResolvedValue({
      url: "http://127.0.0.1:49374",
      auth: { type: "basic", username: "opencode", password: "ext_secret_pw" },
    });
    const child = new FakeChild();
    const fixture = createFixture({ children: [child] });
    await fixture.manager.connectExternal();

    expect(vi.mocked(Service.discover)).toHaveBeenCalledTimes(1);
    expect(fixture.manager.getState()).toBe("running");
    expect(fixture.manager.getMode()).toBe("external");
    expect(fixture.manager.getServerUrl()).toBe("http://127.0.0.1:49374");
    expect(fixture.fetchCalls[0]?.url).toBe("http://127.0.0.1:49374/api/info");
    expect(fixture.fetchCalls[0]?.init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("opencode:ext_secret_pw").toString("base64")}`,
    });
    const headers = await fixture.manager.getAuthHeaders();
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("opencode:ext_secret_pw").toString("base64")}`);

    // stop() on an external service = disconnect only: no Service.stop(), no
    // spawns, no signals — we never kill processes we do not own.
    await fixture.manager.stop();
    expect(fixture.manager.getState()).toBe("stopped");
    expect(vi.mocked(Service.stop)).not.toHaveBeenCalled();
    expect(fixture.calls).toHaveLength(0);
    expect(child.signals).toEqual([]);
    // The credential is dropped from memory on disconnect.
    const dropped = await fixture.manager.getAuthHeaders();
    expect(dropped["Authorization"]).toBeUndefined();
  });

  it("connects to an explicit url + password without discovery", async () => {
    const fixture = createFixture({});
    await fixture.manager.connectExternal({ url: "http://127.0.0.1:5000", password: "explicit_pw" });
    expect(fixture.manager.getState()).toBe("running");
    expect(vi.mocked(Service.discover)).not.toHaveBeenCalled();
    expect(fixture.fetchCalls[0]?.init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("opencode:explicit_pw").toString("base64")}`,
    });
    expect(fixture.logger.allText()).not.toContain("explicit_pw");
  });

  it("falls back to the injected credential callback (SecretStorage wiring)", async () => {
    const fixture = createFixture({
      managerOptions: { getPassword: async () => "stored_pw" },
    });
    await fixture.manager.connectExternal({ url: "http://127.0.0.1:5000" });
    expect(fixture.fetchCalls[0]?.init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("opencode:stored_pw").toString("base64")}`,
    });
  });

  it("reports the error state when the external server is unhealthy", async () => {
    const fetchFn = (async () => statusResponse(401)) as typeof fetch;
    const fixture = createFixture({ fetchFn });
    const error = await fixture.manager
      .connectExternal({ url: "http://127.0.0.1:5000" })
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("401");
    expect(fixture.manager.getState()).toBe("error");
  });

  it("reports the error state when no service is discovered", async () => {
    vi.mocked(Service.discover).mockResolvedValue(undefined);
    const fixture = createFixture({});
    const error = await fixture.manager.connectExternal().catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("No running OpenCode service");
    expect(fixture.manager.getState()).toBe("error");
  });

  it("never logs the external password, even across failure paths", async () => {
    vi.mocked(Service.discover).mockResolvedValue({
      url: "http://127.0.0.1:49374",
      auth: { type: "basic", username: "opencode", password: "ext_secret_pw" },
    });
    const fixture = createFixture({});
    await fixture.manager.connectExternal();
    fixture.manager.onUnhealthy("probe failed");
    await flushMicrotasks();
    expect(fixture.logger.allText()).not.toContain("ext_secret_pw");
  });
});

import { describe, expect, it, vi } from "vitest";
import { RuntimeHealthMonitor, probeHealth } from "../../src/runtime/runtimeHealthMonitor";
import type { HealthProbeResult } from "../../src/runtime/runtimeHealthMonitor";
import { flushMicrotasks, jsonResponse, statusResponse } from "./runtime/helpers";

describe("probeHealth", () => {
  it("reports healthy with the observed version and Basic auth headers", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ version: "2.2.6", pid: 1 });
    }) as typeof fetch;
    const result = await probeHealth("http://127.0.0.1:4096/", {
      fetchFn,
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(result).toMatchObject({ healthy: true, version: "2.2.6" });
    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/api/info"); // trailing slash tolerated
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: "Basic dXNlcjpwYXNz",
      accept: "application/json",
    });
  });

  it("reports unhealthy for HTTP errors", async () => {
    const fetchFn = (async () => statusResponse(401)) as typeof fetch;
    const result = await probeHealth("http://127.0.0.1:4096", { fetchFn });
    expect(result.healthy).toBe(false);
    if (!result.healthy) expect(result.reason).toContain("401");
  });

  it("reports unhealthy for connection failures without throwing", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const result = await probeHealth("http://127.0.0.1:4096", { fetchFn });
    expect(result.healthy).toBe(false);
    if (!result.healthy) expect(result.reason).toContain("Connection failed");
  });

  it("aborts slow probes via the AbortController timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        // A hanging server: the probe must abort via its own timer.
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }) as typeof fetch;
      const attempt = probeHealth("http://127.0.0.1:4096", { fetchFn, timeoutMs: 100 });
      const assertion = expect(attempt).resolves.toMatchObject({ healthy: false, reason: "Request timed out" });
      await vi.advanceTimersByTimeAsync(200);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RuntimeHealthMonitor", () => {
  function makeMonitor(options?: { fetchFn?: typeof fetch; intervalMs?: number }) {
    let status = 200;
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn =
      options?.fetchFn ??
      (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        return status === 200 ? jsonResponse({ version: "2.2.6" }) : statusResponse(status);
      }) as typeof fetch;
    const monitor = new RuntimeHealthMonitor({
      serverUrl: () => "http://127.0.0.1:4096",
      fetchFn,
      intervalMs: options?.intervalMs ?? 100,
      timeoutMs: 1_000,
      headers: () => ({ Authorization: "Basic dXNlcjpwYXNz" }),
    });
    return { monitor, fetchCalls, setStatus: (next: number) => (status = next) };
  }

  it("emits the initial observation and healthy↔unhealthy transitions", async () => {
    vi.useFakeTimers();
    try {
      const { monitor, setStatus } = makeMonitor();
      const seen: HealthProbeResult[] = [];
      monitor.onHealthChange((result) => seen.push(result));

      monitor.start();
      await vi.advanceTimersByTimeAsync(1); // initial probe
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ healthy: true, version: "2.2.6" });

      // Staying healthy emits nothing.
      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toHaveLength(1);

      setStatus(500);
      await vi.advanceTimersByTimeAsync(100);
      expect(seen).toHaveLength(2);
      expect(seen[1]?.healthy).toBe(false);

      // Still unhealthy (network error this time) — no new transition.
      setStatus(200);
      (monitor as unknown as { options: { fetchFn: typeof fetch } }).options.fetchFn = (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch;
      await vi.advanceTimersByTimeAsync(100);
      expect(seen).toHaveLength(2);

      // Recovery emits a healthy transition again.
      (monitor as unknown as { options: { fetchFn: typeof fetch } }).options.fetchFn = (async () =>
        jsonResponse({ version: "2.3.0" })) as typeof fetch;
      await vi.advanceTimersByTimeAsync(100);
      expect(seen).toHaveLength(3);
      expect(seen[2]).toMatchObject({ healthy: true, version: "2.3.0" });

      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("probes on the configured interval until stopped", async () => {
    vi.useFakeTimers();
    try {
      const { monitor, fetchCalls } = makeMonitor({ intervalMs: 100 });
      monitor.start();
      await vi.advanceTimersByTimeAsync(1); // initial probe
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchCalls.length).toBeGreaterThanOrEqual(3);
      expect(monitor.running).toBe(true);

      monitor.stop();
      expect(monitor.running).toBe(false);
      const countAtStop = fetchCalls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(fetchCalls.length).toBe(countAtStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a one-off check via checkOnce()", async () => {
    const { monitor } = makeMonitor();
    const result = await monitor.checkOnce();
    expect(result).toMatchObject({ healthy: true, version: "2.2.6" });
    expect(monitor.lastResult).toMatchObject({ healthy: true });
  });

  it("reports unhealthy when no server URL is configured", async () => {
    const monitor = new RuntimeHealthMonitor({ serverUrl: () => undefined });
    const result = await monitor.checkOnce();
    expect(result.healthy).toBe(false);
  });

  it("passes the Basic auth headers from the provider on every probe", async () => {
    vi.useFakeTimers();
    try {
      const { monitor, fetchCalls } = makeMonitor();
      monitor.start();
      await vi.advanceTimersByTimeAsync(101);
      for (const call of fetchCalls) {
        expect(call.init?.headers).toMatchObject({ Authorization: "Basic dXNlcjpwYXNz" });
        expect(call.url).toBe("http://127.0.0.1:4096/api/info");
      }
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a tick while the previous probe is still in flight", async () => {
    vi.useFakeTimers();
    try {
      let release: ((response: Response) => void) | undefined;
      const gated = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return await gated;
      }) as typeof fetch;
      const { monitor } = makeMonitor({ fetchFn, intervalMs: 50 });
      monitor.start();
      await flushMicrotasks();
      expect(calls).toHaveLength(1); // initial probe in flight

      await vi.advanceTimersByTimeAsync(150); // several intervals pass while gated
      expect(calls).toHaveLength(1); // ticks skipped

      release?.(jsonResponse({ version: "2.2.6" }));
      await flushMicrotasks();
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

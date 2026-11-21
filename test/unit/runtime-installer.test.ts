import { describe, expect, it, vi } from "vitest";
import { InstallError, RuntimeInstaller, UpdateRolledBackError } from "../../src/runtime/runtimeInstaller";
import type { RuntimeInstallerOptions } from "../../src/runtime/runtimeInstaller";
import { VersionMismatchError } from "../../src/runtime/releaseVerifier";
import type { InstallProgress } from "../../shared/protocol";
import { FakeChild, jsonResponse, silentChild, spawnScript, versionChild } from "./runtime/helpers";

const MANAGED_DIR = "/data/managed-runtime";
const MANAGED_EXE = "/data/managed-runtime/node_modules/.bin/opencode";

function registryPayload(versions: string[]): unknown {
  const entries: Record<string, unknown> = {};
  for (const version of versions) {
    entries[version] = {
      version,
      dist: {
        tarball: `https://registry.npmjs.org/opencode/-/opencode-${version}.tgz`,
        integrity: `sha512-fake${version}`,
      },
    };
  }
  return { name: "opencode", "dist-tags": { latest: versions[0] }, versions: entries };
}

interface InstallerFixture {
  installer: RuntimeInstaller;
  spawnCalls: Array<{ command: string; args: readonly string[] }>;
  mkdirCalls: string[];
  fetchMock: ReturnType<typeof vi.fn>;
  probes: string[];
}

function makeInstaller(
  overrides: Partial<RuntimeInstallerOptions> = {},
  probeVersions: string[] = ["2.2.6"],
): InstallerFixture {
  // Default npm children succeed; tests that need failures build their own.
  const { spawnFn, calls } = spawnScript([silentChild(0), silentChild(0), silentChild(0)]);
  const mkdirCalls: string[] = [];
  const probes: string[] = [];
  const probeQueue = [...probeVersions];
  const fetchMock = vi.fn(async () => jsonResponse(registryPayload(["2.2.6", "2.1.0"])));
  const installer = new RuntimeInstaller({
    managedBaseDir: MANAGED_DIR,
    env: { PATH: "/tools/bin:/usr/bin" },
    isWindows: false,
    spawnFn,
    fetchFn: fetchMock as unknown as typeof fetch,
    mkdir: async (path: string) => {
      mkdirCalls.push(path);
    },
    runVersion: async (executablePath: string) => {
      probes.push(executablePath);
      return { version: probeQueue.shift() ?? "2.2.6" };
    },
    npmTimeoutMs: 5_000,
    ...overrides,
  });
  return { installer, spawnCalls: calls, mkdirCalls, fetchMock, probes };
}

function extractError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => error,
  );
}

describe("RuntimeInstaller.detect", () => {
  it("prefers the custom executable path from settings", async () => {
    const { installer, probes } = makeInstaller({
      getSettings: () => ({ executablePath: "/custom/opencode" }),
    });
    const detected = await installer.detect();
    expect(detected).toMatchObject({
      installed: true,
      version: "2.2.6",
      executablePath: "/custom/opencode",
      method: "custom",
    });
    expect(probes).toEqual(["/custom/opencode"]);
  });

  it("reports a broken custom path instead of silently falling back", async () => {
    const { installer } = makeInstaller({
      getSettings: () => ({ executablePath: "/custom/opencode" }),
      runVersion: async () => {
        throw new Error("exec format error");
      },
    });
    const detected = await installer.detect();
    expect(detected.installed).toBe(false);
    expect(detected.method).toBe("custom");
    expect(detected.compatError).toContain("not runnable");
  });

  it("falls back to PATH when no custom path is set", async () => {
    const { installer, probes } = makeInstaller({
      getSettings: () => ({ executablePath: "" }),
      fileExists: async (path: string) => path === "/tools/bin/opencode",
    });
    const detected = await installer.detect();
    expect(detected).toMatchObject({
      installed: true,
      version: "2.2.6",
      executablePath: "/tools/bin/opencode",
      method: "existing",
    });
    expect(probes).toEqual(["/tools/bin/opencode"]);
  });

  it("falls back to the managed directory when PATH has no opencode", async () => {
    const { installer } = makeInstaller({
      getSettings: () => ({ executablePath: "" }),
      fileExists: async (path: string) => path === MANAGED_EXE,
    });
    const detected = await installer.detect();
    expect(detected).toMatchObject({ installed: true, method: "managed", executablePath: MANAGED_EXE });
  });

  it("reports not-installed (method 'existing' → detection 'none') when nothing is found", async () => {
    const { installer } = makeInstaller({
      getSettings: () => ({ executablePath: "" }),
      fileExists: async () => false,
    });
    const detected = await installer.detect();
    expect(detected).toEqual({ installed: false, method: "existing" });
  });

  it("probes Windows-style opencode.cmd shims on a ';'-delimited PATH", async () => {
    const { installer, probes } = makeInstaller({
      getSettings: () => ({ executablePath: "" }),
      env: { PATH: "/a;/b" },
      isWindows: true,
      fileExists: async (path: string) => path === "/b/opencode.cmd",
    });
    const detected = await installer.detect();
    expect(detected.method).toBe("existing");
    expect(detected.executablePath).toBe("/b/opencode.cmd");
    expect(probes).toEqual(["/b/opencode.cmd"]);
  });

  it("flags versions below the minimum as installed but incompatible", async () => {
    const { installer } = makeInstaller(
      {
        getSettings: () => ({ executablePath: "" }),
        fileExists: async (path: string) => path === "/tools/bin/opencode",
      },
      ["1.9.9"],
    );
    const detected = await installer.detect();
    expect(detected.installed).toBe(true);
    expect(detected.version).toBe("1.9.9");
    expect(detected.compatError).toContain("minimum supported version");
  });
});

describe("RuntimeInstaller.install", () => {
  it("installs via npm into the managed dir and verifies the binary", async () => {
    const { installer, spawnCalls, mkdirCalls } = makeInstaller();
    const phases: string[] = [];
    const result = await installer.install({
      onProgress: (progress: InstallProgress) => phases.push(progress.phase),
    });
    expect(result).toEqual({
      version: "2.2.6",
      executablePath: MANAGED_EXE,
      integrity: "sha512-fake2.2.6",
    });
    expect(mkdirCalls).toEqual([MANAGED_DIR]);
    const call = spawnCalls[0];
    expect(call?.command.endsWith("/npm")).toBe(true);
    expect(call?.args).toEqual([
      "install",
      "opencode@2.2.6",
      "--prefix",
      MANAGED_DIR,
      "--no-audit",
      "--no-fund",
      "--loglevel",
      "error",
    ]);
    expect(phases).toEqual(["checking", "downloading", "verifying", "done"]);
  });

  it("fails with an actionable hint when npm is missing (before any network access)", async () => {
    const { installer, fetchMock, spawnCalls } = makeInstaller({
      fileExists: async () => false,
    });
    const error = await extractError(installer.install({}));
    expect(error).toBeInstanceOf(InstallError);
    expect((error as InstallError).message).toContain("npm was not found");
    expect((error as InstallError).hint).toContain("install Node.js");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawnCalls).toHaveLength(0);
  });

  it("surfaces npm failures with the stderr tail", async () => {
    const { spawnFn } = spawnScript([silentChild(1, "EACCES: permission denied")]);
    const installer = new RuntimeInstaller({
      managedBaseDir: MANAGED_DIR,
      env: { PATH: "/tools/bin" },
      isWindows: false,
      spawnFn,
      fetchFn: (async () => jsonResponse(registryPayload(["2.2.6"]))) as unknown as typeof fetch,
      mkdir: async () => undefined,
      runVersion: async () => ({ version: "2.2.6" }),
      npmTimeoutMs: 5_000,
    });
    const error = await extractError(installer.install({}));
    expect(error).toBeInstanceOf(InstallError);
    expect((error as InstallError).message).toContain("exit code 1");
    expect((error as InstallError).message).toContain("EACCES");
  });

  it("fails when the installed binary does not match the resolved release", async () => {
    const { installer } = makeInstaller(
      { fileExists: async (path: string) => path.endsWith("/npm") },
      ["1.0.0"], // the post-install verify probe reports the wrong version
    );
    const error = await extractError(installer.install({}));
    expect(error).toBeInstanceOf(InstallError);
    expect((error as InstallError).cause).toBeInstanceOf(VersionMismatchError);
  });

  it("times out a hung npm install", async () => {
    vi.useFakeTimers();
    try {
      const installer = new RuntimeInstaller({
        managedBaseDir: MANAGED_DIR,
        env: { PATH: "/tools/bin" },
        isWindows: false,
        // Deterministic under fake timers: no real-fs I/O (a real fs await
        // would resolve mid-advance and shift the fake clock).
        fileExists: async (path: string) => path.endsWith("/npm"),
        spawnFn: () => {
          const child = new FakeChild();
          child.autoExitOn = ["SIGKILL"]; // a real npm dies on SIGKILL
          return child;
        },
        fetchFn: (async () => jsonResponse(registryPayload(["2.2.6"]))) as unknown as typeof fetch,
        mkdir: async () => undefined,
        runVersion: async () => ({ version: "2.2.6" }),
        npmTimeoutMs: 100,
      });
      const attempt = extractError(installer.install({}));
      await vi.advanceTimersByTimeAsync(500);
      const error = await attempt;
      expect(error).toBeInstanceOf(InstallError);
      expect((error as InstallError).message).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RuntimeInstaller.update (managed)", () => {
  it("updates to the requested version and reports the previous one", async () => {
    // Probes: current version → post-install verify.
    const { installer, spawnCalls } = makeInstaller({}, ["2.1.0", "2.2.6"]);
    const result = await installer.update(MANAGED_EXE, {
      toVersion: "2.2.6",
      healthCheck: async () => undefined,
    });
    expect(result).toEqual({
      status: "updated",
      executablePath: MANAGED_EXE,
      version: "2.2.6",
      previousVersion: "2.1.0",
    });
    expect(spawnCalls[0]?.args).toContain("opencode@2.2.6");
  });

  it("rolls back to the previous version when the health check fails", async () => {
    // Probes: current → post-install verify → post-rollback verify.
    const { installer, spawnCalls } = makeInstaller({}, ["2.1.0", "2.2.6", "2.1.0"]);
    const error = await extractError(
      installer.update(MANAGED_EXE, {
        healthCheck: async () => {
          throw new Error("health check failed after update");
        },
      }),
    );
    expect(error).toBeInstanceOf(UpdateRolledBackError);
    expect((error as UpdateRolledBackError).from).toBe("2.1.0");
    expect((error as UpdateRolledBackError).message).toContain("health check failed after update");
    expect(spawnCalls[0]?.args).toContain("opencode@2.2.6");
    expect(spawnCalls[1]?.args).toContain("opencode@2.1.0");
  });

  it("reports a combined failure when the rollback itself fails", async () => {
    // npm #1 (update) succeeds; the verify probe fails; npm #2 (rollback) fails.
    const { spawnFn } = spawnScript([silentChild(0), silentChild(1, "npm exploded again")]);
    const installer = new RuntimeInstaller({
      managedBaseDir: MANAGED_DIR,
      env: { PATH: "/tools/bin" },
      isWindows: false,
      spawnFn,
      fetchFn: (async () => jsonResponse(registryPayload(["2.2.6", "2.1.0"]))) as unknown as typeof fetch,
      mkdir: async () => undefined,
      runVersion: (() => {
        let call = 0;
        return async () => {
          call += 1;
          if (call === 1) return { version: "2.1.0" }; // current version probe
          throw new Error("binary is broken"); // verify probes fail
        };
      })(),
      npmTimeoutMs: 5_000,
    });
    const error = await extractError(installer.update(MANAGED_EXE, { toVersion: "2.2.6" }));
    expect(error).toBeInstanceOf(InstallError);
    expect((error as InstallError).message).toContain("rollback to 2.1.0 failed");
  });
});

describe("RuntimeInstaller.update (external)", () => {
  it("returns a manual instruction by default", async () => {
    const { installer, spawnCalls } = makeInstaller();
    const result = await installer.update("/usr/local/bin/opencode");
    expect(result).toEqual({
      status: "manual",
      executablePath: "/usr/local/bin/opencode",
      instruction: expect.stringContaining("opencode upgrade"),
    });
    expect(spawnCalls).toHaveLength(0);
  });

  it("executes `opencode upgrade` when the approval hook accepts", async () => {
    const { spawnFn, calls } = spawnScript([versionChild("opencode v2.3.0")]);
    const installer = new RuntimeInstaller({
      managedBaseDir: MANAGED_DIR,
      env: { PATH: "/tools/bin" },
      isWindows: false,
      spawnFn,
      fetchFn: (async () => jsonResponse(registryPayload(["2.3.0"]))) as unknown as typeof fetch,
      runVersion: (() => {
        let call = 0;
        return async () => {
          call += 1;
          return { version: call === 1 ? "2.2.6" : "2.3.0" };
        };
      })(),
      upgradeTimeoutMs: 5_000,
    });
    const result = await installer.update("/usr/local/bin/opencode", {
      approveUpgrade: async () => true,
    });
    expect(result).toEqual({
      status: "updated",
      executablePath: "/usr/local/bin/opencode",
      version: "2.3.0",
      previousVersion: "2.2.6",
    });
    expect(calls[0]?.command).toBe("/usr/local/bin/opencode");
    expect(calls[0]?.args).toEqual(["upgrade"]);
  });

  it("returns the manual instruction when the approval hook declines", async () => {
    const { installer, spawnCalls } = makeInstaller();
    const result = await installer.update("/usr/local/bin/opencode", {
      approveUpgrade: async () => false,
    });
    expect(result.status).toBe("manual");
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("RuntimeInstaller.latestVersion", () => {
  it("returns the registry latest version", async () => {
    const { installer } = makeInstaller();
    await expect(installer.latestVersion()).resolves.toBe("2.2.6");
  });

  it("returns undefined when the registry is unreachable", async () => {
    const { installer } = makeInstaller({
      fetchFn: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(installer.latestVersion()).resolves.toBeUndefined();
  });
});

describe("RuntimeInstaller.helpers", () => {
  it("classifies paths inside the managed directory", () => {
    const { installer } = makeInstaller();
    expect(installer.isManagedPath(MANAGED_EXE)).toBe(true);
    expect(installer.isManagedPath("/usr/local/bin/opencode")).toBe(false);
    expect(installer.managedExecutablePath()).toBe(MANAGED_EXE);
  });

  it("reports platform info with the injected remote hint", () => {
    const { installer } = makeInstaller({ platform: { remoteName: "ssh-remote+7" } });
    const info = installer.platformInfo();
    expect(info.isRemote).toBe(true);
    expect(info.remote).toBe("ssh-remote+7");
  });
});

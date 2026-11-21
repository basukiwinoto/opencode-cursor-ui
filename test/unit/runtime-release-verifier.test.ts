import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertTarballIntegrity,
  BinaryNotWorkingError,
  computeSri,
  fetchReleaseMetadata,
  IntegrityMismatchError,
  MetadataValidationError,
  NPM_REGISTRY_URL,
  RegistryUnavailableError,
  runBinaryVersion,
  verifyInstalledBinary,
  verifyRegistryMetadata,
  VersionMismatchError,
  VersionNotFoundError,
} from "../../src/runtime/releaseVerifier";
import type { SpawnFn } from "../../src/runtime/exec";
import { FakeChild, jsonResponse, spawnScript, statusResponse, versionChild } from "./runtime/helpers";

function registryPayload(versions: string[], latest = versions[0] ?? "2.2.6"): unknown {
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
  return { name: "opencode", "dist-tags": { latest }, versions: entries };
}

describe("verifyRegistryMetadata", () => {
  it("accepts well-formed package metadata", () => {
    const metadata = verifyRegistryMetadata(registryPayload(["2.2.6"]));
    expect(metadata.name).toBe("opencode");
    expect(metadata["dist-tags"]?.["latest"]).toBe("2.2.6");
    expect(metadata.versions?.["2.2.6"]?.dist?.tarball).toContain("opencode-2.2.6.tgz");
  });

  it("rejects non-object payloads", () => {
    expect(() => verifyRegistryMetadata("nope")).toThrow(MetadataValidationError);
    expect(() => verifyRegistryMetadata(null)).toThrow(MetadataValidationError);
  });

  it("rejects a missing name", () => {
    expect(() => verifyRegistryMetadata({ versions: {} })).toThrow(MetadataValidationError);
  });

  it("rejects non-string dist-tags values", () => {
    expect(() => verifyRegistryMetadata({ name: "opencode", "dist-tags": { latest: 2 } })).toThrow(
      MetadataValidationError,
    );
  });

  it("rejects a non-object versions map", () => {
    expect(() => verifyRegistryMetadata({ name: "opencode", versions: [] })).toThrow(MetadataValidationError);
  });

  it("rejects non-string tarballs", () => {
    const payload = {
      name: "opencode",
      versions: { "2.2.6": { version: "2.2.6", dist: { tarball: 42, integrity: "sha512-x" } } },
    };
    expect(() => verifyRegistryMetadata(payload)).toThrow(MetadataValidationError);
  });
});

describe("fetchReleaseMetadata", () => {
  it("resolves dist-tags.latest when no version is requested", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(registryPayload(["2.2.6", "2.1.0"])));
    const metadata = await fetchReleaseMetadata(undefined, fetchFn);
    expect(metadata).toEqual({
      version: "2.2.6",
      tarballUrl: "https://registry.npmjs.org/opencode/-/opencode-2.2.6.tgz",
      integrity: "sha512-fake2.2.6",
    });
    expect(fetchFn).toHaveBeenCalledWith(NPM_REGISTRY_URL, expect.objectContaining({ headers: { accept: "application/json" } }));
  });

  it("resolves an explicitly requested version", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(registryPayload(["2.2.6", "2.1.0"])));
    const metadata = await fetchReleaseMetadata("2.1.0", fetchFn);
    expect(metadata.version).toBe("2.1.0");
    expect(metadata.integrity).toBe("sha512-fake2.1.0");
  });

  it("throws RegistryUnavailableError when fetch rejects (network failure)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchReleaseMetadata(undefined, fetchFn)).rejects.toBeInstanceOf(RegistryUnavailableError);
  });

  it("throws RegistryUnavailableError on HTTP errors", async () => {
    const fetchFn = vi.fn(async () => statusResponse(502));
    await expect(fetchReleaseMetadata(undefined, fetchFn)).rejects.toThrow(/502/);
  });

  it("throws RegistryUnavailableError on non-JSON bodies", async () => {
    const fetchFn = vi.fn(async () => new Response("<html>blocked</html>", { status: 200 }));
    await expect(fetchReleaseMetadata(undefined, fetchFn)).rejects.toBeInstanceOf(RegistryUnavailableError);
  });

  it("throws VersionNotFoundError for unknown versions", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(registryPayload(["2.2.6"])));
    await expect(fetchReleaseMetadata("9.9.9", fetchFn)).rejects.toBeInstanceOf(VersionNotFoundError);
  });

  it("throws MetadataValidationError when dist-tags.latest is missing", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ name: "opencode", versions: { "2.2.6": { version: "2.2.6", dist: { tarball: "t", integrity: "sha512-x" } } } }),
    );
    await expect(fetchReleaseMetadata(undefined, fetchFn)).rejects.toBeInstanceOf(MetadataValidationError);
  });

  it("throws MetadataValidationError when integrity is missing", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        name: "opencode",
        "dist-tags": { latest: "2.2.6" },
        versions: { "2.2.6": { version: "2.2.6", dist: { tarball: "https://example.test/t.tgz" } } },
      }),
    );
    await expect(fetchReleaseMetadata(undefined, fetchFn)).rejects.toThrow(/integrity/);
  });

  it("throws MetadataValidationError on non-sha512 integrity", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        name: "opencode",
        "dist-tags": { latest: "2.2.6" },
        versions: { "2.2.6": { version: "2.2.6", dist: { tarball: "https://example.test/t.tgz", integrity: "sha1-abc" } } },
      }),
    );
    await expect(fetchReleaseMetadata(undefined, fetchFn)).rejects.toBeInstanceOf(MetadataValidationError);
  });
});

describe("assertTarballIntegrity", () => {
  it("accepts a matching sha512 SRI hash", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const sri = `sha512-${createHash("sha512").update(data).digest("base64")}`;
    expect(computeSri(data)).toBe(sri);
    expect(() => assertTarballIntegrity(data, sri)).not.toThrow();
  });

  it("throws IntegrityMismatchError on tampered data", () => {
    const data = new Uint8Array([1, 2, 3]);
    const sri = `sha512-${createHash("sha512").update(data).digest("base64")}`;
    expect(() => assertTarballIntegrity(new Uint8Array([9, 9, 9]), sri)).toThrow(IntegrityMismatchError);
  });

  it("refuses weaker hash algorithms", () => {
    expect(() => assertTarballIntegrity(new Uint8Array([1]), "sha1-abc")).toThrow(MetadataValidationError);
  });
});

describe("runBinaryVersion", () => {
  it("parses real `opencode --version` output", async () => {
    const { spawnFn, calls } = spawnScript([versionChild("opencode v2.2.6")]);
    const result = await runBinaryVersion("/opt/homebrew/bin/opencode", { spawnFn });
    expect(result.version).toBe("2.2.6");
    expect(calls[0]?.args).toEqual(["--version"]);
  });

  it("throws BinaryNotWorkingError on non-zero exit", async () => {
    const { spawnFn } = spawnScript([versionChild("", 1)]);
    await expect(runBinaryVersion("/broken/opencode", { spawnFn })).rejects.toBeInstanceOf(BinaryNotWorkingError);
  });

  it("throws BinaryNotWorkingError when the executable cannot spawn (ENOENT)", async () => {
    const child = new FakeChild();
    const { spawnFn } = spawnScript([child]);
    // Emit asynchronously so the spawn-time listeners are attached first.
    void Promise.resolve().then(() =>
      child.emitError(Object.assign(new Error("spawn /missing ENOENT"), { code: "ENOENT" })),
    );
    await expect(runBinaryVersion("/missing/opencode", { spawnFn })).rejects.toThrow(/ENOENT/);
  });

  it("classifies a spawnFn that throws synchronously as BinaryNotWorkingError", async () => {
    const failingSpawn: SpawnFn = () => {
      throw new Error("EACCES: permission denied");
    };
    await expect(runBinaryVersion("/locked/opencode", { spawnFn: failingSpawn })).rejects.toBeInstanceOf(
      BinaryNotWorkingError,
    );
  });

  it("throws BinaryNotWorkingError on unparseable output", async () => {
    const { spawnFn } = spawnScript([versionChild("this is not a version")]);
    await expect(runBinaryVersion("/weird/opencode", { spawnFn })).rejects.toThrow(/parse/);
  });

  it("throws BinaryNotWorkingError and SIGKILLs on timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      child.autoExitOn = ["SIGKILL"]; // a real process dies on SIGKILL
      const { spawnFn } = spawnScript([child]);
      const attempt = runBinaryVersion("/hung/opencode", { spawnFn, timeoutMs: 100 }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(300);
      const error = await attempt;
      expect(error).toBeInstanceOf(BinaryNotWorkingError);
      expect(child.signals).toContain("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("verifyInstalledBinary", () => {
  it("accepts the exact expected version", async () => {
    const { spawnFn } = spawnScript([versionChild("opencode v2.2.6")]);
    const result = await verifyInstalledBinary("/managed/opencode", "2.2.6", { spawnFn });
    expect(result.version).toBe("2.2.6");
  });

  it("throws VersionMismatchError on a different version", async () => {
    const { spawnFn } = spawnScript([versionChild("opencode v2.2.6")]);
    await expect(verifyInstalledBinary("/managed/opencode", "2.3.0", { spawnFn })).rejects.toBeInstanceOf(
      VersionMismatchError,
    );
  });

  it("propagates BinaryNotWorkingError for broken binaries", async () => {
    const { spawnFn } = spawnScript([versionChild("", 1)]);
    await expect(verifyInstalledBinary("/managed/opencode", "2.2.6", { spawnFn })).rejects.toBeInstanceOf(
      BinaryNotWorkingError,
    );
  });
});

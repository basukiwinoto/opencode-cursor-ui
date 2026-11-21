import { describe, expect, it } from "vitest";
import {
  binaryPackageName,
  createPlatformResolver,
  detectPlatform,
  normalizeRemoteName,
  PlatformResolver,
  serviceRegistrationPath,
} from "../../src/runtime/platformResolver";

describe("binaryPackageName", () => {
  it("maps darwin", () => {
    expect(binaryPackageName("darwin", "arm64")).toBe("opencode-darwin-arm64");
    expect(binaryPackageName("darwin", "x64")).toBe("opencode-darwin-x64");
    expect(binaryPackageName("darwin", "ia32")).toBeUndefined();
  });

  it("maps linux", () => {
    expect(binaryPackageName("linux", "x64")).toBe("opencode-linux-x64");
    expect(binaryPackageName("linux", "arm64")).toBe("opencode-linux-arm64");
    expect(binaryPackageName("linux", "arm")).toBeUndefined();
  });

  it("maps win32", () => {
    expect(binaryPackageName("win32", "x64")).toBe("opencode-win32-x64");
    expect(binaryPackageName("win32", "arm64")).toBeUndefined();
  });

  it("returns undefined for unknown platforms", () => {
    expect(binaryPackageName("sunos", "x64")).toBeUndefined();
    expect(binaryPackageName("freebsd", "arm64")).toBeUndefined();
  });
});

describe("normalizeRemoteName", () => {
  it("maps VS Code's remoteName values to string | null", () => {
    expect(normalizeRemoteName(undefined)).toBeNull();
    expect(normalizeRemoteName(null)).toBeNull();
    expect(normalizeRemoteName("")).toBeNull();
    expect(normalizeRemoteName("   ")).toBeNull();
    expect(normalizeRemoteName("ssh-remote+7")).toBe("ssh-remote+7");
    expect(normalizeRemoteName("wsl")).toBe("wsl");
  });
});

describe("detectPlatform", () => {
  it("defaults to the Node process facts and reports local", () => {
    const info = detectPlatform();
    expect(info.os).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    expect(info.remote).toBeNull();
    expect(info.isRemote).toBe(false);
  });

  it("honors explicit overrides", () => {
    const info = detectPlatform({ platform: "win32", arch: "x64", remoteName: "dev-container" });
    expect(info).toEqual({ os: "win32", arch: "x64", remote: "dev-container", isRemote: true });
  });

  it("treats an empty remoteName as local", () => {
    expect(detectPlatform({ remoteName: "" }).isRemote).toBe(false);
  });

  it("evaluates an injected remoteName getter", () => {
    let remoteName: string | undefined;
    const info = detectPlatform({ remoteName: () => remoteName });
    expect(info.isRemote).toBe(false);
    remoteName = "ssh-remote+7";
    expect(detectPlatform({ remoteName: () => remoteName }).isRemote).toBe(true);
  });
});

describe("PlatformResolver", () => {
  it("exposes a PlatformContext with OS helpers", () => {
    const resolver = new PlatformResolver({ platform: "win32", arch: "x64" });
    expect(resolver.context.isWindows()).toBe(true);
    expect(resolver.context.isMacOS()).toBe(false);
    expect(resolver.context.isLinux()).toBe(false);
    expect(resolver.context.binaryPackageName()).toBe("opencode-win32-x64");
    expect(resolver.context.platform).toEqual({ os: "win32", arch: "x64", remote: null, isRemote: false });
  });

  it("maps macOS and linux helpers", () => {
    expect(new PlatformResolver({ platform: "darwin", arch: "arm64" }).context.isMacOS()).toBe(true);
    expect(new PlatformResolver({ platform: "linux", arch: "x64" }).context.isLinux()).toBe(true);
  });

  it("re-evaluates the remote getter on every access (remotes can change mid-session)", () => {
    let remoteName: string | undefined;
    const resolver = new PlatformResolver({ remoteName: () => remoteName });
    expect(resolver.context.platform.isRemote).toBe(false);
    remoteName = "wsl";
    expect(resolver.context.platform.isRemote).toBe(true);
    expect(resolver.context.platform.remote).toBe("wsl");
  });

  it("resolves the injected homedir and falls back to os.homedir()", () => {
    expect(new PlatformResolver({ homedir: "/home/tester" }).homedir()).toBe("/home/tester");
    expect(new PlatformResolver().homedir().length).toBeGreaterThan(0);
  });
});

describe("createPlatformResolver", () => {
  it("returns a resolver wired for VS Code injection", () => {
    const resolver = createPlatformResolver({
      platform: "darwin",
      arch: "arm64",
      remoteName: () => "ssh-remote+0",
    });
    expect(resolver.context.binaryPackageName()).toBe("opencode-darwin-arm64");
    expect(resolver.context.platform).toEqual({
      os: "darwin",
      arch: "arm64",
      remote: "ssh-remote+0",
      isRemote: true,
    });
  });
});

describe("serviceRegistrationPath", () => {
  it("points at the XDG shared-service registration file", () => {
    expect(serviceRegistrationPath("/home/tester")).toBe("/home/tester/.local/state/opencode/service.json");
  });
});

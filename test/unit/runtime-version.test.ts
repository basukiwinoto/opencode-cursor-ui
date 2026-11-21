import { describe, expect, it } from "vitest";
import { compareVersions, extractVersionToken, parseVersion } from "../../src/runtime/version";
import { isVersionAtLeast, MIN_OPENCODE_VERSION } from "../../src/runtime/types";

describe("compareVersions", () => {
  it("treats identical versions as equal", () => {
    expect(compareVersions("2.2.6", "2.2.6")).toBe(0);
  });

  it("ignores a leading v/V prefix", () => {
    expect(compareVersions("v2.2.6", "2.2.6")).toBe(0);
    expect(compareVersions("V2.2.6", "v2.2.6")).toBe(0);
  });

  it("treats missing components as zero", () => {
    expect(compareVersions("2.2", "2.2.0")).toBe(0);
    expect(compareVersions("2", "2.0.0")).toBe(0);
  });

  it("compares numerically, not lexically", () => {
    expect(compareVersions("2.2.10", "2.2.6")).toBe(1);
    expect(compareVersions("2.2.6", "2.2.10")).toBe(-1);
    expect(compareVersions("2.10.0", "2.9.99")).toBe(1);
    expect(compareVersions("10.0.0", "9.99.99")).toBe(1);
  });

  it("compares major before minor before patch", () => {
    expect(compareVersions("1.9.9", "2.0.0")).toBe(-1);
    expect(compareVersions("2.0.0", "2.1.0")).toBe(-1);
    expect(compareVersions("2.1.0", "2.1.1")).toBe(-1);
  });

  it("ranks a release above its own prereleases", () => {
    expect(compareVersions("2.2.6", "2.2.6-beta")).toBe(1);
    expect(compareVersions("2.2.6-beta", "2.2.6")).toBe(-1);
  });

  it("compares numeric prerelease identifiers numerically", () => {
    expect(compareVersions("2.2.6-beta.2", "2.2.6-beta.10")).toBe(-1);
    expect(compareVersions("2.2.6-beta.10", "2.2.6-beta.2")).toBe(1);
  });

  it("compares alphanumeric prerelease identifiers lexically", () => {
    expect(compareVersions("2.3.0-alpha", "2.3.0-beta")).toBe(-1);
    expect(compareVersions("2.3.0-rc.1", "2.3.0-beta.3")).toBe(1);
  });

  it("ranks numeric identifiers below alphanumeric ones", () => {
    expect(compareVersions("2.0.0-1", "2.0.0-alpha")).toBe(-1);
  });

  it("treats fewer prerelease identifiers as lower precedence", () => {
    expect(compareVersions("2.2.6-beta", "2.2.6-beta.1")).toBe(-1);
  });

  it("ignores build metadata", () => {
    expect(compareVersions("2.2.6+build.5", "2.2.6")).toBe(0);
    expect(compareVersions("2.2.6+build.5", "2.2.6+build.9")).toBe(0);
  });

  it("degrades unparseable input to 0.0.0", () => {
    // Note: dashes read as prerelease separators ("not-a-version" parses as
    // 0.0.0-a.version), so use dash-free garbage for the 0.0.0 assertion.
    expect(compareVersions("garbage", "0.0.0")).toBe(0);
    expect(compareVersions("garbage", "2.0.0")).toBe(-1);
    expect(compareVersions("", "0.0.1")).toBe(-1);
  });

  it("handles prerelease on only one side with garbage", () => {
    expect(compareVersions("2.2.6-beta", "oops")).toBe(1);
  });
});

describe("parseVersion", () => {
  it("parses a plain three-component version", () => {
    expect(parseVersion("2.2.6")).toEqual({ major: 2, minor: 2, patch: 6, prerelease: [] });
  });

  it("strips v prefixes and tolerates two components", () => {
    expect(parseVersion("v2.10")).toEqual({ major: 2, minor: 10, patch: 0, prerelease: [] });
  });

  it("keeps prerelease identifiers and drops build metadata", () => {
    expect(parseVersion("2.10.3-beta.2+build.7")).toEqual({
      major: 2,
      minor: 10,
      patch: 3,
      prerelease: ["beta", "2"],
    });
  });

  it("never yields NaN", () => {
    const parsed = parseVersion("x.y.z");
    expect(parsed.major).toBe(0);
    expect(parsed.minor).toBe(0);
    expect(parsed.patch).toBe(0);
  });
});

describe("extractVersionToken", () => {
  it("extracts the version from real `opencode --version` output", () => {
    expect(extractVersionToken("opencode v2.2.6")).toBe("2.2.6");
    expect(extractVersionToken("opencode v2.10.0-rc.1")).toBe("2.10.0-rc.1");
    expect(extractVersionToken("2.2.6")).toBe("2.2.6");
  });

  it("returns undefined for unrecognizable output", () => {
    expect(extractVersionToken("hello world")).toBeUndefined();
    expect(extractVersionToken("")).toBeUndefined();
  });
});

describe("isVersionAtLeast (compat gate from types.ts)", () => {
  it("accepts the minimum version itself", () => {
    expect(isVersionAtLeast(MIN_OPENCODE_VERSION, MIN_OPENCODE_VERSION)).toBe(true);
  });

  it("rejects older versions and accepts newer ones", () => {
    expect(isVersionAtLeast("1.9.9", MIN_OPENCODE_VERSION)).toBe(false);
    expect(isVersionAtLeast("2.2.6", MIN_OPENCODE_VERSION)).toBe(true);
  });

  it("tolerates v prefixes and partial components", () => {
    expect(isVersionAtLeast("v2.2.6", "2.0.0")).toBe(true);
    expect(isVersionAtLeast("2.1", "2.0.0")).toBe(true);
  });
});

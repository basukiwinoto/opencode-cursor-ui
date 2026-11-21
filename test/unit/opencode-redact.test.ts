import { describe, expect, it } from "vitest";
import { redactSdkPayload, sanitizeModelOption, sanitizeProviderOption } from "../../src/opencode/redact";

describe("redactSdkPayload", () => {
  it("strips apiKey deeply nested in settings", () => {
    const payload = {
      id: "anthropic/claude-4",
      providerID: "anthropic",
      settings: {
        apiKey: "sk-ant-live-000000000000000000",
        baseURL: "https://api.anthropic.com",
        nested: { apiKey: "sk-ant-deep-00000000000000", keep: true },
      },
    };
    const redacted = redactSdkPayload(payload) as typeof payload;
    expect(redacted.id).toBe("anthropic/claude-4");
    expect(redacted.settings.baseURL).toBe("https://api.anthropic.com");
    expect(redacted.settings.nested.keep).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain("sk-ant-live");
    expect(JSON.stringify(redacted)).not.toContain("sk-ant-deep");
    expect(JSON.stringify(redacted)).toContain("https://api.anthropic.com");
  });

  it("scrubs sk- style keys inside arbitrary strings", () => {
    const redacted = redactSdkPayload({
      note: "key is sk-proj-abcdef1234567890abcdef please rotate",
    }) as { note: string };
    expect(redacted.note).not.toContain("sk-proj-abcdef1234567890");
    expect(redacted.note).toContain("key is");
    expect(redacted.note).toContain("please rotate");
  });

  it("scrubs inline Basic/Bearer credentials", () => {
    const redacted = redactSdkPayload({ header: "Basic YWxsbHlvdXJiYXNlMTIzNDU2Nzg=" }) as { header: string };
    expect(redacted.header).not.toContain("YWxsbHlvdXJiYXNl");
  });

  it("redacts credential-ish keys like password, authorization and token", () => {
    const redacted = redactSdkPayload({
      password: "server-password-value",
      headers: { authorization: "Basic xyz", "content-type": "application/json" },
      token: "t",
    }) as Record<string, unknown>;
    expect(redacted["password"]).toBe("[TRUNCATED-SECRET]");
    expect(redacted["token"]).toBe("[TRUNCATED-SECRET]");
    const headers = redacted["headers"] as Record<string, unknown>;
    expect(headers["authorization"]).toBe("[TRUNCATED-SECRET]");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("deep-clones arrays and primitives and never mutates the input", () => {
    const input = {
      list: [{ apiKey: "sk-0000000000000000" }, 1, "two", null, true],
    };
    const snapshot = structuredClone(input);
    const redacted = redactSdkPayload(input) as typeof input;
    expect(input).toEqual(snapshot);
    expect(redacted).not.toBe(input);
    expect((redacted.list[0] as Record<string, unknown>)["apiKey"]).toBe("[TRUNCATED-SECRET]");
    expect(redacted.list[1]).toBe(1);
    expect(redacted.list[2]).toBe("two");
    expect(redacted.list[3]).toBeNull();
    expect(redacted.list[4]).toBe(true);
  });

  it("collapses non-JSON values to null", () => {
    const redacted = redactSdkPayload({ fn: () => 42 }) as { fn: unknown };
    expect(redacted.fn).toBeNull();
  });
});

describe("sanitizeModelOption", () => {
  it("projects label = name ?? modelID and drops every other field", () => {
    const option = sanitizeModelOption({
      id: "anthropic/claude-4",
      modelID: "claude-4",
      providerID: "anthropic",
      name: "Claude 4",
      family: "claude",
      type: "chat",
      settings: { apiKey: "sk-live-000000000000000000", baseURL: "https://example.com" },
      capabilities: {},
      limit: { context: 1, output: 2 },
    });
    expect(option).toEqual({
      providerID: "anthropic",
      modelID: "claude-4",
      label: "Claude 4",
      family: "claude",
      type: "chat",
    });
  });

  it("falls back to modelID for the label and id for modelID", () => {
    const option = sanitizeModelOption({ id: "fallback-model", providerID: "openai" });
    expect(option).toEqual({
      providerID: "openai",
      modelID: "fallback-model",
      label: "fallback-model",
      family: undefined,
      type: undefined,
    });
  });

  it("returns null without identifiers and never leaks secrets", () => {
    expect(sanitizeModelOption({ name: "no ids" })).toBeNull();
    const option = sanitizeModelOption({
      providerID: "p",
      modelID: "m",
      settings: { apiKey: "sk-live-000000000000000000" },
    });
    expect(JSON.stringify(option)).not.toContain("sk-live");
  });
});

describe("sanitizeProviderOption", () => {
  it("projects id/name/activation and the supplied modelCount", () => {
    const option = sanitizeProviderOption(
      {
        id: "anthropic",
        name: "Anthropic",
        activation: "enabled",
        settings: { apiKey: "sk-live-000000000000000000" },
      },
      7,
    );
    expect(option).toEqual({ id: "anthropic", name: "Anthropic", activation: "enabled", modelCount: 7 });
  });

  it("falls back to id for the name and returns null without an id", () => {
    expect(sanitizeProviderOption({ name: "no id" })).toBeNull();
    expect(sanitizeProviderOption({ id: "p" })).toEqual({
      id: "p",
      name: "p",
      activation: undefined,
      modelCount: 0,
    });
  });
});

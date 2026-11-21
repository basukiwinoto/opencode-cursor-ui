import { describe, expect, it } from "vitest";
import { redactString, redactValue, RingLogger } from "../../src/core/logger";

describe("secret redaction", () => {
  it("redacts sk- style API keys", () => {
    expect(redactString("using key sk-abcdef1234567890abcdef12 later")).toBe("using key [REDACTED] later");
  });

  it("redacts authorization headers", () => {
    expect(redactString("authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng==")).toBe("authorization: [REDACTED]");
  });

  it("redacts registered server passwords even mid-string", () => {
    const logger = new RingLogger({ appendLine: () => {} }, 10, "debug");
    logger.registerSecret("s3cr3t-server-password");
    logger.info("connected with s3cr3t-server-password ok");
    expect(logger.snapshot()[0]?.message).not.toContain("s3cr3t-server-password");
  });

  it("deep redacts apiKey and password fields", () => {
    const input = {
      settings: { apiKey: "sk-live-123456789", baseURL: "https://api.example.com" },
      nested: [{ password: "hunter2", keep: "visible" }],
    };
    const output = redactValue(input) as {
      settings: { apiKey: string; baseURL: string };
      nested: Array<{ password: string; keep: string }>;
    };
    expect(output.settings.apiKey).toBe("[REDACTED]");
    expect(output.settings.baseURL).toBe("https://api.example.com");
    expect(output.nested[0]?.password).toBe("[REDACTED]");
    expect(output.nested[0]?.keep).toBe("visible");
  });

  it("respects log level filtering", () => {
    const logger = new RingLogger({ appendLine: () => {} }, 10, "warn");
    logger.debug("hidden");
    logger.warn("shown");
    const entries = logger.snapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe("warn");
  });
});

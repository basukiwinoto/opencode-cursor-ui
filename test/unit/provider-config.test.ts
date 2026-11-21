import { describe, expect, it } from "vitest";
import {
  isHttpUrl,
  isValidProviderId,
  renderApiKey,
  writeCustomProvider,
  type ModelConfigFs,
} from "../../src/opencode/providerConfig";

function fakeFs(files: Map<string, string>, copies: Array<[string, string]> = []): ModelConfigFs {
  return {
    readFile: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    copyFile: async (s, d) => {
      const content = files.get(s);
      if (content === undefined) throw new Error("ENOENT");
      copies.push([s, d]);
      files.set(d, content);
    },
    access: async (p) => {
      if (!files.has(p)) throw new Error("ENOENT");
    },
    mkdir: async () => undefined,
  };
}

const ENV = { XDG_CONFIG_HOME: "/c" };

describe("provider config helpers", () => {
  it("validates provider ids and URLs", () => {
    expect(isValidProviderId("my-proxy")).toBe(true);
    expect(isValidProviderId("My_Proxy1")).toBe(true);
    expect(isValidProviderId("-bad")).toBe(false);
    expect(isValidProviderId("has space")).toBe(false);
    expect(isHttpUrl("https://api.example.com/v1")).toBe(true);
    expect(isHttpUrl("ftp://x")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });

  it("renders env references symbolically", () => {
    expect(renderApiKey("env:MY_KEY")).toBe("{env:MY_KEY}");
    expect(renderApiKey("sk-literal")).toBe("sk-literal");
    expect(renderApiKey("  ")).toBeUndefined();
  });

  it("adds a custom provider preserving existing config", async () => {
    const files = new Map([
      [
        "/c/opencode/opencode.json",
        JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "old/model", provider: { existing: { name: "E" } } }),
      ],
    ]);
    const copies: Array<[string, string]> = [];
    const result = await writeCustomProvider(
      {
        id: "my-proxy",
        name: "My Proxy",
        baseURL: "https://api.example.com/v1/",
        apiKey: "env:MY_KEY",
        models: [{ id: "gpt-4o", name: "GPT-4o", context: 128000 }],
      },
      fakeFs(files, copies),
      ENV,
    );
    expect(result.ok).toBe(true);
    expect(copies).toHaveLength(1);
    const written = JSON.parse(files.get("/c/opencode/opencode.json") ?? "{}") as {
      provider: Record<string, { name: string; npm: string; options: Record<string, unknown>; models?: Record<string, unknown> }>;
      model: string;
    };
    expect(written.model).toBe("old/model");
    expect(written.provider.existing.name).toBe("E");
    expect(written.provider["my-proxy"]?.name).toBe("My Proxy");
    expect(written.provider["my-proxy"]?.npm).toBe("@ai-sdk/openai-compatible");
    expect(written.provider["my-proxy"]?.options.baseURL).toBe("https://api.example.com/v1");
    expect(written.provider["my-proxy"]?.options.apiKey).toBe("{env:MY_KEY}");
    expect(written.provider["my-proxy"]?.models?.["gpt-4o"]).toMatchObject({ name: "GPT-4o" });
  });

  it("rejects invalid ids and URLs before touching the config", async () => {
    const files = new Map([["/c/opencode/opencode.json", JSON.stringify({ keep: true })]]);
    const fsApi = fakeFs(files);
    const badId = await writeCustomProvider({ id: "bad id", name: "x", baseURL: "https://ok" }, fsApi, ENV);
    expect(badId.ok).toBe(false);
    const badUrl = await writeCustomProvider({ id: "ok", name: "x", baseURL: "nope" }, fsApi, ENV);
    expect(badUrl.ok).toBe(false);
    expect(files.get("/c/opencode/opencode.json")).toBe(JSON.stringify({ keep: true }));
  });

  it("refuses to overwrite malformed JSON", async () => {
    const files = new Map([["/c/opencode/opencode.json", "{ broken"]]);
    const result = await writeCustomProvider({ id: "ok", name: "x", baseURL: "https://ok" }, fakeFs(files), ENV);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not valid JSON");
    expect(files.get("/c/opencode/opencode.json")).toBe("{ broken");
  });
});

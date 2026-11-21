import { describe, expect, it } from "vitest";
import {
  formatModelString,
  opencodeConfigPath,
  parseModelString,
  readDefaultAgent,
  readDefaultModel,
  writeDefaultAgent,
  writeDefaultModel,
  type ModelConfigFs,
} from "../../src/opencode/modelConfig";

function fakeFs(files: Map<string, string>, writes: string[] = [], copies: Array<[string, string]> = []): ModelConfigFs {
  return {
    readFile: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
    writeFile: async (p, data) => {
      writes.push(p);
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

describe("model config helpers", () => {
  it("parses provider/model strings", () => {
    expect(parseModelString("neuralwatt/glm-5.3-flash")).toEqual({ providerID: "neuralwatt", modelID: "glm-5.3-flash", variant: undefined });
    expect(parseModelString("p/m/variant")).toEqual({ providerID: "p", modelID: "m", variant: "variant" });
    expect(parseModelString("just-a-string")).toBeUndefined();
    expect(parseModelString(undefined)).toBeUndefined();
  });

  it("formats refs back to strings", () => {
    expect(formatModelString({ providerID: "a", modelID: "b" })).toBe("a/b");
    expect(formatModelString({ providerID: "a", modelID: "b", variant: "v" })).toBe("a/b/v");
  });

  it("resolves the XDG-aware config path", () => {
    expect(opencodeConfigPath("/home/u", {})).toBe("/home/u/.config/opencode/opencode.json");
    expect(opencodeConfigPath("/home/u", { XDG_CONFIG_HOME: "/custom" })).toBe("/custom/opencode/opencode.json");
  });

  it("reads the default model from an existing config", async () => {
    const fsApi = fakeFs(new Map([["/c/opencode/opencode.json", JSON.stringify({ model: "neuralwatt/glm-5.3-flash" })]]));
    expect(await readDefaultModel(fsApi, { XDG_CONFIG_HOME: "/c" })).toEqual({ providerID: "neuralwatt", modelID: "glm-5.3-flash", variant: undefined });
  });

  it("returns undefined when config is missing or has no model", async () => {
    expect(await readDefaultModel(fakeFs(new Map()), {})).toBeUndefined();
    const fsApi = fakeFs(new Map([["/c/opencode/opencode.json", JSON.stringify({ other: 1 })]]));
    expect(await readDefaultModel(fsApi, { XDG_CONFIG_HOME: "/c" })).toBeUndefined();
  });

  it("writes the model key preserving every other key", async () => {
    const files = new Map([
      ["/c/opencode/opencode.json", JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "old/model", permissions: [{ action: "shell" }] })],
    ]);
    const copies: Array<[string, string]> = [];
    const fsApi = fakeFs(files, [], copies);
    const result = await writeDefaultModel({ providerID: "neuralwatt", modelID: "glm-5.2" }, fsApi, { XDG_CONFIG_HOME: "/c" });
    expect(result.ok).toBe(true);
    expect(copies).toHaveLength(1); // backup created
    const written = JSON.parse(files.get("/c/opencode/opencode.json") ?? "{}") as { model: string; permissions: unknown[] };
    expect(written.model).toBe("neuralwatt/glm-5.2");
    expect(written.$schema).toBe("https://opencode.ai/config.json");
    expect(written.permissions).toEqual([{ action: "shell" }]);
  });

  it("refuses to overwrite malformed JSON", async () => {
    const files = new Map([["/c/opencode/opencode.json", "{ not valid json"]]);
    const fsApi = fakeFs(files);
    const result = await writeDefaultModel({ providerID: "a", modelID: "b" }, fsApi, { XDG_CONFIG_HOME: "/c" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not valid JSON");
    expect(files.get("/c/opencode/opencode.json")).toBe("{ not valid json");
  });

  it("creates a fresh config when none exists", async () => {
    const files = new Map<string, string>();
    const fsApi = fakeFs(files);
    const result = await writeDefaultModel({ providerID: "a", modelID: "b" }, fsApi, { XDG_CONFIG_HOME: "/c" });
    expect(result.ok).toBe(true);
    const written = JSON.parse(files.get("/c/opencode/opencode.json") ?? "{}") as { model: string; $schema: string };
    expect(written.model).toBe("a/b");
    expect(written.$schema).toContain("config.json");
  });

  it("reads and writes the default agent key", async () => {
    const files = new Map([
      ["/c/opencode/opencode.json", JSON.stringify({ model: "a/b", default_agent: "sisyphus" })],
    ]);
    expect(await readDefaultAgent(fakeFs(files), { XDG_CONFIG_HOME: "/c" })).toBe("sisyphus");
    const copies: Array<[string, string]> = [];
    const result = await writeDefaultAgent("build", fakeFs(files, copies), { XDG_CONFIG_HOME: "/c" });
    expect(result.ok).toBe(true);
    expect(copies).toHaveLength(1);
    const written = JSON.parse(files.get("/c/opencode/opencode.json") ?? "{}") as { default_agent: string; model: string };
    expect(written.default_agent).toBe("build");
    expect(written.model).toBe("a/b");
  });

  it("returns undefined for a missing agent key", async () => {
    const files = new Map([["/c/opencode/opencode.json", JSON.stringify({ model: "a/b" })]]);
    expect(await readDefaultAgent(fakeFs(files), { XDG_CONFIG_HOME: "/c" })).toBeUndefined();
  });
});

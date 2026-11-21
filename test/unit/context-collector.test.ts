import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = {
  activeTextEditor: undefined as unknown | undefined,
  diagnostics: [] as Array<{ severity: number }>,
};

vi.mock("vscode", () => ({
  window: {
    get activeTextEditor() {
      return vscodeState.activeTextEditor;
    },
  },
  languages: {
    getDiagnostics: () => vscodeState.diagnostics,
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  Uri: {
    file: (path: string) => ({ scheme: "file", fsPath: path, toString: () => `file://${path}` }),
  },
}));

import { ContextCollector } from "../../src/editor/contextCollector";

const settings = {
  autoIncludeSelection: true,
  includeDiagnostics: true,
} as unknown as Parameters<typeof ContextCollector>[0];

function makeEditor(options: { path: string; selectedText?: string; selectionEmpty?: boolean }) {
  const selection = {
    isEmpty: options.selectionEmpty ?? options.selectedText === undefined,
    start: { line: options.selectedText ? 9 : 0 },
  };
  return {
    document: {
      uri: { scheme: "file", fsPath: options.path, toString: () => `file://${options.path}` },
      getText: (sel: unknown) => (sel && !(selection as { isEmpty: boolean }).isEmpty ? (options.selectedText ?? "") : options.selectedText ?? ""),
    },
    selection,
  };
}

describe("ContextCollector", () => {
  beforeEach(() => {
    vscodeState.activeTextEditor = undefined;
    vscodeState.diagnostics = [];
  });

  it("returns no context without an active editor", () => {
    const collector = new ContextCollector(() => settings as never);
    const result = collector.collect();
    expect(result.attachments).toHaveLength(0);
    expect(result.editorContext).toBeUndefined();
  });

  it("attaches the active file when there is no selection", () => {
    vscodeState.activeTextEditor = makeEditor({ path: "/repo/src/index.ts" });
    const collector = new ContextCollector(() => settings as never);
    const result = collector.collect();
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({ kind: "file", name: "index.ts" });
    expect(result.editorContext?.activeFile?.name).toBe("index.ts");
    expect(result.promptAttachments[0]?.name).toBe("index.ts");
  });

  it("attaches selection with line info when text is selected", () => {
    vscodeState.activeTextEditor = makeEditor({ path: "/repo/src/app.ts", selectedText: "const x = 1;" });
    const collector = new ContextCollector(() => settings as never);
    const result = collector.collect();
    expect(result.editorContext?.selection).toMatchObject({ path: "/repo/src/app.ts", startLine: 10 });
    expect(result.attachments[0]?.kind).toBe("selection");
    expect(result.promptAttachments[0]?.name).toBe("app.ts:10");
  });

  it("attaches nothing when includeSelectionOverride=false", () => {
    vscodeState.activeTextEditor = makeEditor({ path: "/repo/src/app.ts", selectedText: "const x = 1;" });
    const collector = new ContextCollector(() => settings as never);
    const result = collector.collect(false);
    expect(result.editorContext?.selection).toBeUndefined();
    expect(result.attachments).toHaveLength(0);
    expect(result.promptAttachments).toHaveLength(0);
  });

  it("counts error/warning diagnostics for the active file", () => {
    vscodeState.activeTextEditor = makeEditor({ path: "/repo/src/app.ts" });
    vscodeState.diagnostics = [{ severity: 0 }, { severity: 1 }, { severity: 2 }];
    const collector = new ContextCollector(() => settings as never);
    const result = collector.collect();
    expect(result.editorContext?.diagnosticCount).toBe(2);
    expect(result.attachments.some((a) => a.kind === "diagnostics")).toBe(true);
  });
});

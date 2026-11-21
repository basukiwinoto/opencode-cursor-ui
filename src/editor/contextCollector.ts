import * as vscode from "vscode";
import type { AttachmentView, EditorContext } from "../../shared/protocol";
import type { ExtensionSettings } from "../config/settings";
import type { PromptAttachment } from "../opencode/types";

export interface CollectedContext {
  editorContext?: EditorContext;
  attachments: AttachmentView[];
  promptAttachments: PromptAttachment[];
}

/** Collects active editor context for prompt enrichment. */
export class ContextCollector {
  constructor(private readonly getSettings: () => ExtensionSettings) {}

  collect(includeSelectionOverride?: boolean): CollectedContext {
    const settings = this.getSettings();
    const includeSelection = includeSelectionOverride ?? settings.autoIncludeSelection;
    const editor = vscode.window.activeTextEditor;
    const attachments: AttachmentView[] = [];
    const promptAttachments: PromptAttachment[] = [];
    let editorContext: EditorContext | undefined;

    if (editor && isCollectableUri(editor.document.uri)) {
      const path = editor.document.uri.fsPath;
      const name = path.split(/[\\/]/).pop() ?? path;
      editorContext = { activeFile: { path, name } };

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      if (includeSelection && selection && !selection.isEmpty && selectedText.trim().length > 0) {
        const startLine = selection.start.line + 1;
        editorContext.selection = { path, name, text: selectedText, startLine };
        attachments.push({ name, uri: editor.document.uri.toString(), kind: "selection" });
        promptAttachments.push({
          uri: editor.document.uri.toString(),
          name: `${name}:${startLine}`,
        });
      } else if (includeSelection) {
        attachments.push({ name, uri: editor.document.uri.toString(), kind: "file" });
        promptAttachments.push({ uri: editor.document.uri.toString(), name });
      }

      if (settings.includeDiagnostics) {
        const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
        const problems = diagnostics.filter(
          (d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning,
        );
        if (problems.length > 0) {
          editorContext.diagnosticCount = problems.length;
          attachments.push({ name: `${problems.length} problems`, uri: editor.document.uri.toString(), kind: "diagnostics" });
        }
      }
    }

    return { editorContext, attachments, promptAttachments };
  }
}

function isCollectableUri(uri: vscode.Uri): boolean {
  return uri.scheme === "file" || uri.scheme === "vscode-vfs" || uri.scheme === "untitled";
}

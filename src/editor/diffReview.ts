import * as vscode from "vscode";
import type { ExtensionSettings } from "../config/settings";

/**
 * Opens native VS Code diffs between the pre-edit snapshot (when captured)
 * and the current file content. Falls back to opening the file when no
 * snapshot exists. Never reverts or overwrites user changes.
 */
export class DiffReviewService {
  constructor(
    private readonly snapshots: { snapshotUriFor(path: string): vscode.Uri | undefined; has(path: string): boolean },
    private readonly getSettings: () => ExtensionSettings,
  ) {}

  async open(path: string, line?: number): Promise<void> {
    const current = vscode.Uri.file(path);
    const label = path.split(/[\\/]/).pop() ?? path;

    if (this.getSettings().useNativeDiff && this.snapshots.has(path)) {
      const before = this.snapshots.snapshotUriFor(path);
      if (before) {
        const selection = line !== undefined ? new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0) : undefined;
        await vscode.commands.executeCommand("vscode.diff", before, current, `${label} (OpenCode change)`, {
          preview: true,
        });
        if (selection) {
          const document = await vscode.workspace.openTextDocument(current);
          await vscode.window.showTextDocument(document, { preview: true, selection });
        }
        return;
      }
    }

    const document = await vscode.workspace.openTextDocument(current);
    await vscode.window.showTextDocument(document, { preview: true });
  }
}

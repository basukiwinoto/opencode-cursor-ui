import * as vscode from "vscode";
import { DisposableStore } from "../core/disposables";
import type { Log } from "../core/logger";

export const SNAPSHOT_SCHEME = "opencode-cursor-ui-snapshot";

/**
 * Content provider for in-memory pre-edit snapshots, used as the "before"
 * side of native diff review. Snapshots are captured before the agent's
 * edit tools first touch a file and are never written to disk.
 */
export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  private readonly snapshots = new Map<string, string>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.snapshots.get(uri.toString()) ?? "";
  }

  store(path: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path, query: snapshotKey(path) });
    this.snapshots.set(uri.toString(), content);
    return uri;
  }

  has(path: string): boolean {
    return this.snapshots.has(snapshotUriString(path));
  }

  /** The snapshot URI to use as the "before" side of a native diff, if captured. */
  snapshotUriFor(path: string): vscode.Uri | undefined {
    const uri = vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path, query: snapshotKey(path) });
    return this.snapshots.has(uri.toString()) ? uri : undefined;
  }

  clear(): void {
    this.snapshots.clear();
    this.onDidChangeEmitter.fire(vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: "/" }));
  }

  dispose(): void {
    this.snapshots.clear();
    this.onDidChangeEmitter.dispose();
  }
}

function snapshotKey(path: string): string {
  return Buffer.from(path).toString("base64url");
}

function snapshotUriString(path: string): string {
  return vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path, query: snapshotKey(path) }).toString();
}

const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "patch", "apply_patch", "create_file", "edit_file"]);

/**
 * Tracks files modified by agent operations and captures safe pre-edit
 * snapshots. Rollback is intentionally NOT implemented here: the extension
 * offers diff review and navigation only, never destructive reversal.
 */
export class FileChangeTracker {
  private readonly disposables = new DisposableStore();

  constructor(
    private readonly provider: SnapshotContentProvider,
    private readonly logger: Log,
  ) {}

  /** Called when an edit tool starts against a file: capture the pre-edit content. */
  async capturePreEdit(tool: string, input: unknown): Promise<void> {
    if (!EDIT_TOOLS.has(tool.toLowerCase())) return;
    const path = extractFilePath(input);
    if (!path) return;
    const uri = vscode.Uri.file(path);
    if (this.provider.has(path)) return;
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      this.provider.store(path, document.getText());
    } catch {
      // File may not exist yet (create) — nothing to snapshot; diff uses empty base.
      this.provider.store(path, "");
    }
  }

  dispose(): void {
    this.disposables.dispose();
    this.provider.dispose();
  }
}

export function extractFilePath(input: unknown): string | undefined {
  if (typeof input === "string") {
    const candidate = input.trim();
    if (/^([\w.~\\/]:)?[\w.~\\/-]+$/.test(candidate) && candidate.includes(".")) return candidate;
    return undefined;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = extractFilePath(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    for (const key of ["file", "path", "filePath", "target"]) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
    for (const value of Object.values(record)) {
      const found = extractFilePath(value);
      if (found) return found;
    }
  }
  return undefined;
}

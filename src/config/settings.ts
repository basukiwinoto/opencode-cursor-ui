import * as vscode from "vscode";
import type { LogLevel } from "../core/logger";

export const SECTION = "opencodeCursorUI";

export interface ExtensionSettings {
  runtimeMode: "managed" | "external";
  executablePath: string;
  autoStart: boolean;
  startupTimeoutMs: number;
  autoUpdate: boolean;
  externalServerUrl: string;
  restoreLastSession: boolean;
  autoIncludeSelection: boolean;
  includeDiagnostics: boolean;
  showToolCalls: boolean;
  showFileChanges: boolean;
  interactivePermissions: boolean;
  useNativeDiff: boolean;
  logLevel: LogLevel;
}

export function readSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration(SECTION);
  const get = <T>(key: string, fallback: T): T => config.get<T>(key, fallback);
  return {
    runtimeMode: get<"managed" | "external">("runtime.mode", "managed"),
    executablePath: get("runtime.executablePath", ""),
    autoStart: get("runtime.autoStart", true),
    startupTimeoutMs: get("runtime.startupTimeoutMs", 30_000),
    autoUpdate: get("runtime.autoUpdate", false),
    externalServerUrl: get("external.serverUrl", ""),
    restoreLastSession: get("session.restoreLast", true),
    autoIncludeSelection: get("editor.autoIncludeSelection", true),
    includeDiagnostics: get("editor.includeDiagnostics", true),
    showToolCalls: get("ui.showToolCalls", true),
    showFileChanges: get("ui.showFileChanges", true),
    interactivePermissions: get("permissions.interactive", true),
    useNativeDiff: get("diff.useNativeDiff", true),
    logLevel: get<LogLevel>("log.level", "info"),
  };
}

export function onSettingsChange(handler: (settings: ExtensionSettings) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SECTION)) {
      handler(readSettings());
    }
  });
}

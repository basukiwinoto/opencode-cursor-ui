/**
 * Typed wrapper around the VS Code webview API.
 *
 * `acquireVsCodeApi` may only ever be called once per webview page, so the
 * real handle lives behind a module-level singleton.
 */
import type { WebviewToHost } from "../../shared/protocol";

export interface VsCodeApi<T = unknown> {
  postMessage(message: unknown): void;
  getState(): T | undefined;
  setState(state: T): void;
}

declare function acquireVsCodeApi<T = unknown>(): VsCodeApi<T>;

let api: VsCodeApi | undefined;

/** Acquire (once) and return the VS Code webview API handle. */
export function getVsCodeApi<T = unknown>(): VsCodeApi<T> {
  if (!api) {
    if (typeof acquireVsCodeApi !== "function") {
      throw new Error("acquireVsCodeApi is only available inside a VS Code webview");
    }
    api = acquireVsCodeApi();
  }
  return api as VsCodeApi<T>;
}

/**
 * Post a message to the extension host. This is the ONLY outbound channel;
 * every payload must conform to `WebviewToHost`.
 */
export function postToHost(message: WebviewToHost): void {
  try {
    getVsCodeApi().postMessage(message);
  } catch {
    // Running outside a webview (e.g. plain browser during development):
    // drop the message instead of crashing the UI.
  }
}

// ---------------------------------------------------------------------------
// Webview-persisted state (survives webview reloads / panel hiding)
// ---------------------------------------------------------------------------

export interface WebviewPersistedState {
  /** Draft text keyed by session id (or the synthetic no-session key). */
  drafts?: Record<string, string>;
  /** Open chat tabs, in display order (Cursor-style multi-chat tabs). */
  openTabs?: string[];
  /** Inline sessions pane visibility (Cursor split layout). */
  sidebarOpen?: boolean;
}

export function loadPersisted(): WebviewPersistedState {
  try {
    const state = getVsCodeApi<WebviewPersistedState>().getState();
    return state ?? {};
  } catch {
    return {};
  }
}

export function persist(patch: Partial<WebviewPersistedState>): void {
  try {
    const handle = getVsCodeApi<WebviewPersistedState>();
    const merged: WebviewPersistedState = { ...(handle.getState() ?? {}), ...patch };
    handle.setState(merged);
  } catch {
    // Outside a webview (local dev): ignore.
  }
}

/**
 * Central zustand store.
 *
 * Holds the full `UiState` pushed by the host plus small amounts of local
 * (non-protocol) UI state: toasts, optimistic edits, and per-session draft
 * attachments. All host traffic funnels through `applyHostMessage`; all host
 * traffic leaves through `postToHost`.
 */
import { create } from "zustand";
import type {
  AttachmentView,
  HostToWebview,
  UiState,
} from "../../shared/protocol";
import { loadPersisted, persist, postToHost } from "./vscodeApi";

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const MAX_LOG_ENTRIES = 500;
const MAX_TOASTS = 4;
const DRAFT_SAVE_DEBOUNCE_MS = 400;

/** Draft key used when no session is active yet (first message of a chat). */
export const NO_SESSION_DRAFT_KEY = "__new__";

export function draftKeyFor(sessionID: string | null | undefined): string {
  return sessionID ?? NO_SESSION_DRAFT_KEY;
}

export function initialUiState(): UiState {
  return {
    view: "chat",
    runtime: { state: "starting", mode: "managed", updateAvailable: false },
    setup: undefined,
    installProgress: undefined,
    sessions: [],
    activeSessionID: undefined,
    messages: [],
    drafts: {},
    models: [],
    providers: [],
    agents: [],
    selectedModel: undefined,
    selectedAgent: undefined,
    busySessions: {},
    fileChanges: [],
    permissions: [],
    showToolCalls: true,
    showFileChanges: true,
    canStop: false,
    logs: [],
    editorContext: undefined,
  };
}

interface Toast {
  id: number;
  kind: "error" | "info";
  message: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface AppStore extends UiState {
  /** Transient error/info toasts (host "error"/"info" messages). */
  toasts: Toast[];
  /** Outgoing-message attachments keyed by draft key (local only). */
  draftFiles: Record<string, AttachmentView[]>;
  /** Open chat tabs in display order (Cursor-style). Local UI state. */
  openTabs: string[];
  /** Inline sessions pane next to the chat (Cursor split layout). Local UI state. */
  sidebarOpen: boolean;

  /** Feed one `HostToWebview` message into the store. */
  applyHostMessage: (msg: HostToWebview) => void;
  /** Send `ready` exactly once (webview -> host handshake). */
  sendReady: () => void;

  /** Open a session in a tab: switch active, clear stale content, notify host. */
  openTab: (sessionID: string) => void;
  /** Close a tab (session stays in history); activate a neighbor if it was active. */
  closeTab: (sessionID: string) => void;

  /** Update the draft for the active session locally + debounced saveDraft. */
  setDraft: (text: string) => void;
  /** Clear draft + attachments after sending; flushes saveDraft immediately. */
  clearDraft: () => void;
  getDraft: () => string;
  addDraftFile: (file: AttachmentView) => void;
  removeDraftFile: (name: string) => void;
  getDraftFiles: () => AttachmentView[];

  /** Switch views; posts `navigate` unless suppressed. */
  setView: (view: UiState["view"], opts?: { notifyHost?: boolean }) => void;
  /** Optimistic "new chat": clear conversation, keep sessions + drafts. */
  startNewChatLocal: () => void;
  /** Optimistic session open: clear conversation until host pushes state. */
  openSessionLocal: (sessionID: string) => void;
  /** Toggle the inline sessions pane. */
  toggleSidebar: () => void;
  openSidebar: () => void;
  closeSidebar: () => void;

  /** Optimistic file-change reviewed toggle. */
  toggleFileReviewed: (path: string) => void;
  /** Optimistic permission dismissal + permissionReply message. */
  replyPermission: (
    requestID: string,
    sessionID: string,
    decision: "once" | "always" | "reject",
  ) => void;
  /** Optimistic session rename / delete (after the host message was posted). */
  applyRenameSession: (sessionID: string, title: string) => void;
  applyDeleteSession: (sessionID: string) => void;

  pushToast: (kind: "error" | "info", message: string, detail?: string) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 0;
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let readySent = false;

function withTab(tabs: string[], sessionID: string | undefined): string[] {
  if (sessionID === undefined || tabs.includes(sessionID)) return tabs;
  return [...tabs, sessionID];
}

const persisted = loadPersisted();

export const useAppStore = create<AppStore>()((set, get) => ({
  ...initialUiState(),
  toasts: [],
  draftFiles: {},
  openTabs: persisted.openTabs ?? [],
  sidebarOpen: persisted.sidebarOpen ?? false,
  // Hydrate drafts persisted from a previous webview instance; host state
  // will fill in anything else.
  drafts: persisted.drafts ?? {},

  sendReady: () => {
    if (readySent) return;
    readySent = true;
    postToHost({ type: "ready" });
  },

  applyHostMessage: (msg) => {
    switch (msg.type) {
      case "state": {
        set((s) => {
          // Any session the host activates (restore, new chat) opens a tab;
          // tabs for sessions deleted server-side are dropped (the active one
          // is always kept — a fresh session may not be listed yet).
          const active = msg.state.activeSessionID;
          const known = new Set(msg.state.sessions.map((x) => x.id));
          const openTabs = withTab(s.openTabs, active).filter((id) => id === active || known.has(id));
          return {
            ...msg.state,
            // Locally typed drafts win over the last host snapshot so rapid
            // typing is never clobbered by an in-flight state push.
            drafts: { ...msg.state.drafts, ...s.drafts },
            openTabs,
          };
        });
        break;
      }
      case "patch": {
        set((s) => {
          const next: Partial<AppStore> = { ...msg.state };
          if (msg.state.drafts !== undefined) {
            next.drafts = { ...msg.state.drafts, ...s.drafts };
          }
          if (msg.state.activeSessionID !== undefined) {
            next.openTabs = withTab(s.openTabs, msg.state.activeSessionID);
          }
          return next;
        });
        break;
      }
      case "messageUpserted": {
        if (msg.sessionID !== get().activeSessionID) break;
        set((s) => {
          const index = s.messages.findIndex((m) => m.id === msg.message.id);
          const messages = s.messages.slice();
          if (index >= 0) {
            messages[index] = msg.message;
          } else {
            messages.push(msg.message);
          }
          return { messages };
        });
        break;
      }
      case "permissionAsked": {
        set((s) =>
          s.permissions.some((p) => p.requestID === msg.request.requestID)
            ? {}
            : { permissions: [...s.permissions, msg.request] },
        );
        break;
      }
      case "permissionResolved": {
        set((s) => ({
          permissions: s.permissions.filter((p) => p.requestID !== msg.requestID),
        }));
        break;
      }
      case "fileChangesUpdated": {
        set({ fileChanges: msg.changes });
        break;
      }
      case "installProgress": {
        set({ installProgress: msg.progress });
        break;
      }
      case "logAppended": {
        set((s) => ({
          logs: [...s.logs, ...msg.entries].slice(-MAX_LOG_ENTRIES),
        }));
        break;
      }
      case "error": {
        get().pushToast("error", msg.message, msg.detail);
        break;
      }
      case "info": {
        get().pushToast("info", msg.message);
        break;
      }
    }
  },

  setDraft: (text) => {
    const sessionID = get().activeSessionID ?? null;
    const key = draftKeyFor(sessionID);
    set((s) => ({ drafts: { ...s.drafts, [key]: text } }));
    if (draftTimer !== undefined) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = undefined;
      const drafts = get().drafts;
      postToHost({ type: "saveDraft", sessionID, text: drafts[key] ?? "" });
      // Also persist into webview state so drafts survive a reload.
      persist({ drafts });
    }, DRAFT_SAVE_DEBOUNCE_MS);
  },

  clearDraft: () => {
    const sessionID = get().activeSessionID ?? null;
    const key = draftKeyFor(sessionID);
    if (draftTimer !== undefined) {
      clearTimeout(draftTimer);
      draftTimer = undefined;
    }
    set((s) => ({
      drafts: { ...s.drafts, [key]: "" },
      draftFiles: { ...s.draftFiles, [key]: [] },
    }));
    postToHost({ type: "saveDraft", sessionID, text: "" });
    persist({ drafts: get().drafts });
  },

  getDraft: () => get().drafts[draftKeyFor(get().activeSessionID)] ?? "",

  addDraftFile: (file) => {
    const key = draftKeyFor(get().activeSessionID);
    set((s) => {
      const list = s.draftFiles[key] ?? [];
      if (list.some((f) => f.uri === file.uri && f.kind === file.kind)) return {};
      return { draftFiles: { ...s.draftFiles, [key]: [...list, file] } };
    });
  },

  removeDraftFile: (name) => {
    const key = draftKeyFor(get().activeSessionID);
    set((s) => {
      const list = s.draftFiles[key] ?? [];
      return { draftFiles: { ...s.draftFiles, [key]: list.filter((f) => f.name !== name) } };
    });
  },

  getDraftFiles: () => get().draftFiles[draftKeyFor(get().activeSessionID)] ?? [],

  setView: (view, opts) => {
    set({ view });
    if (opts?.notifyHost !== false) {
      postToHost({ type: "navigate", view });
    }
  },

  startNewChatLocal: () => {
    set({
      view: "chat",
      messages: [],
      activeSessionID: undefined,
      fileChanges: [],
      permissions: [],
      installProgress: undefined,
    });
  },

  openSessionLocal: (sessionID) => {
    set((s) => ({
      view: "chat",
      activeSessionID: sessionID,
      messages: [],
      fileChanges: [],
      permissions: [],
      openTabs: withTab(s.openTabs, sessionID),
    }));
    persist({ openTabs: get().openTabs });
  },

  openTab: (sessionID) => {
    get().openSessionLocal(sessionID);
    postToHost({ type: "openSession", sessionID });
  },

  toggleSidebar: () => {
    const open = !get().sidebarOpen;
    set({ sidebarOpen: open });
    persist({ sidebarOpen: open });
  },

  openSidebar: () => {
    if (!get().sidebarOpen) {
      set({ sidebarOpen: true });
      persist({ sidebarOpen: true });
    }
  },

  closeSidebar: () => {
    if (get().sidebarOpen) {
      set({ sidebarOpen: false });
      persist({ sidebarOpen: false });
      // If the host forced the history route, return to chat so it stops
      // re-opening the pane.
      if (get().view === "history") {
        set({ view: "chat" });
        postToHost({ type: "navigate", view: "chat" });
      }
    }
  },

  closeTab: (sessionID) => {
    const index = get().openTabs.indexOf(sessionID);
    if (index < 0) return;
    const tabs = get().openTabs.filter((id) => id !== sessionID);
    set({ openTabs: tabs });
    persist({ openTabs: tabs });
    if (get().activeSessionID !== sessionID) return;
    const neighbor = tabs[Math.max(0, index - 1)] ?? tabs[0];
    if (neighbor !== undefined) {
      get().openTab(neighbor);
    } else {
      get().startNewChatLocal();
      postToHost({ type: "newChat" });
    }
  },

  toggleFileReviewed: (path) => {
    set((s) => ({
      fileChanges: s.fileChanges.map((c) =>
        c.path === path ? { ...c, reviewed: !c.reviewed } : c,
      ),
    }));
  },

  replyPermission: (requestID, sessionID, decision) => {
    set((s) => ({ permissions: s.permissions.filter((p) => p.requestID !== requestID) }));
    postToHost({ type: "permissionReply", requestID, sessionID, decision });
  },

  applyRenameSession: (sessionID, title) => {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === sessionID ? { ...x, title } : x)),
    }));
  },

  applyDeleteSession: (sessionID) => {
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== sessionID),
    }));
  },

  pushToast: (kind, message, detail) => {
    const id = ++toastSeq;
    set((s) => ({
      toasts: [...s.toasts, { id, kind, message, detail }].slice(-MAX_TOASTS),
    }));
    setTimeout(() => {
      const current = get().toasts.find((t) => t.id === id);
      if (current) get().dismissToast(id);
    }, kind === "error" ? 8000 : 5000);
  },

  dismissToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

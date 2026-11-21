/**
 * Top-level view router. Reads `state.view` from the store and renders the
 * matching screen. Also owns the host message listener and toasts.
 */
import { useEffect, type ReactNode } from "react";
import { isHostToWebview } from "../../shared/protocol";
import { postToHost } from "./vscodeApi";
import { useAppStore } from "./store";
import { TabBar } from "./components/TabBar";
import { Conversation } from "./components/Conversation";
import { FileChangesSection } from "./components/FileChanges";
import { Composer } from "./components/Composer";
import { SessionsSidebar } from "./components/SessionsSidebar";
import { SetupScreen } from "./components/SetupScreen";
import { ControlCenter } from "./components/ControlCenter";
import { Icon } from "./components/Icon";
import { cn } from "./utils";

/** Chat screen: tab bar + conversation + changes + composer, with an optional inline sessions pane. */
function ChatView({ forceSidebar = false }: { forceSidebar?: boolean }) {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen) || forceSidebar;
  const closeSidebar = useAppStore((s) => s.closeSidebar);
  const setView = useAppStore((s) => s.setView);
  const view = useAppStore((s) => s.view);
  const permissions = useAppStore((s) => s.permissions);
  const firstPending = permissions[0];

  const chat = (
    <div className="chat-view">
      <TabBar />
      <Conversation />
      {firstPending && <StickyPermissionBar title={firstPending.title} />}
      <FileChangesSection />
      <Composer />
    </div>
  );

  if (!sidebarOpen) return chat;

  return (
    <div className="chat-split">
      <div className="chat-pane">{chat}</div>
      <aside className="sessions-pane" aria-label="Sessions">
        <SessionsSidebar
          onClose={() => {
            closeSidebar();
            if (forceSidebar && view === "history") setView("chat");
          }}
        />
      </aside>
    </div>
  );
}

/** Compact sticky reminder shown above the composer while a permission pends. */
function StickyPermissionBar({ title }: { title: string }) {
  return (
    <button
      type="button"
      className="perm-sticky"
      onClick={() => {
        document.querySelector(".perm-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
      }}
      title="Review permission request"
    >
      <Icon name="alert" size={13} className="perm-sticky-icon" />
      <span className="perm-sticky-title">Permission needed: {title}</span>
      <span className="perm-sticky-review">Review</span>
    </button>
  );
}

function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cn("toast", t.kind === "error" ? "toast-error" : "toast-info")}>
          <Icon name={t.kind === "error" ? "alert" : "check"} size={13} />
          <span className="toast-msg">
            {t.message}
            {t.detail ? ` — ${t.detail}` : ""}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Dismiss notification"
            onClick={() => dismiss(t.id)}
          >
            <Icon name="x" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const view = useAppStore((s) => s.view);

  useEffect(() => {
    useAppStore.getState().sendReady();
    // Ask for a fresh model/agent catalog alongside the initial handshake.
    postToHost({ type: "requestCatalog" });
    const handler = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (isHostToWebview(data)) {
        useAppStore.getState().applyHostMessage(data);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  let body: ReactNode;
  switch (view) {
    case "history":
      // The history route is the chat with the sessions pane pinned open.
      body = <ChatView forceSidebar />;
      break;
    case "setup":
      body = <SetupScreen />;
      break;
    case "control":
      body = <ControlCenter />;
      break;
    case "chat":
    default:
      body = <ChatView />;
      break;
  }

  return (
    <div className="app">
      {body}
      <Toasts />
    </div>
  );
}

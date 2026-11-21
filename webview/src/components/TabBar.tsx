/**
 * Cursor-style tab strip: one tab per open chat (icon + title + close),
 * "+" to open a new chat, "…" for history / control center / settings.
 * A subtle runtime status dot sits left of the "+".
 */
import { useEffect, useRef, useState } from "react";
import { postToHost } from "../vscodeApi";
import { useAppStore } from "../store";
import { cn } from "../utils";
import { Icon } from "./Icon";

const STATE_DOT_CLASS: Record<string, string> = {
  running: "dot-green",
  starting: "dot-yellow pulse",
  reconnecting: "dot-yellow pulse",
  installing: "dot-yellow pulse",
  updating: "dot-yellow pulse",
  error: "dot-red",
  not_installed: "dot-red",
  stopped: "dot-gray",
};

export function TabBar() {
  const openTabs = useAppStore((s) => s.openTabs);
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionID = useAppStore((s) => s.activeSessionID);
  const busySessions = useAppStore((s) => s.busySessions);
  const runtime = useAppStore((s) => s.runtime);
  const view = useAppStore((s) => s.view);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const openSidebar = useAppStore((s) => s.openSidebar);
  const openTab = useAppStore((s) => s.openTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const startNewChat = useAppStore((s) => s.startNewChatLocal);
  const setView = useAppStore((s) => s.setView);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const titleFor = (sessionID: string): string => {
    const session = sessions.find((s) => s.id === sessionID);
    return session?.title || "New chat";
  };

  const dotClass = STATE_DOT_CLASS[runtime.state] ?? "dot-gray";
  const tooltip = [
    `OpenCode: ${runtime.state}`,
    runtime.version ? `v${runtime.version}` : undefined,
    runtime.error,
  ]
    .filter(Boolean)
    .join(" · ");

  const onNewChat = () => {
    startNewChat();
    postToHost({ type: "newChat" });
  };

  return (
    <div className="tabbar" role="tablist" aria-label="Open chats">
      <div className="tabbar-tabs">
        {openTabs.map((sessionID) => {
          const active = sessionID === activeSessionID;
          const busy = busySessions[sessionID] === true;
          return (
            <div
              key={sessionID}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              className={cn("tab", active && "tab-active")}
              onClick={() => {
                if (!active) openTab(sessionID);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (!active) openTab(sessionID);
                }
              }}
              title={titleFor(sessionID)}
            >
              <Icon name="chat" size={12} className="tab-icon" />
              <span className="tab-title">{titleFor(sessionID)}</span>
              {busy && <Icon name="spinner" size={11} className="icon-spin tab-busy" />}
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${titleFor(sessionID)}`}
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(sessionID);
                }}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="tabbar-actions">
        <span className={cn("status-dot", dotClass)} title={tooltip} />
        <button
          type="button"
          className={cn("icon-btn", sidebarOpen && "icon-btn-active")}
          aria-label="Toggle sessions sidebar"
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? "Hide sessions sidebar" : "Show sessions sidebar"}
          onClick={toggleSidebar}
        >
          <Icon name="panel" size={15} />
        </button>
        <button type="button" className="icon-btn" aria-label="New chat" title="New chat" onClick={onNewChat}>
          <Icon name="plus" size={15} />
        </button>
        <div className="tabbar-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="icon-btn"
            aria-label="More"
            aria-expanded={menuOpen}
            title="More"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name="dots" size={15} />
          </button>
          {menuOpen && (
            <div className="tabbar-menu" role="menu">
              <button
                type="button"
                className="tabbar-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  openSidebar();
                }}
              >
                <Icon name="clock" size={13} />
                <span>Chat history</span>
              </button>
              <button
                type="button"
                className="tabbar-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setView("control", { notifyHost: false });
                  postToHost({ type: "openControlCenter" });
                }}
              >
                <Icon name="gear" size={13} />
                <span>Control Center</span>
              </button>
              <button
                type="button"
                className="tabbar-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  postToHost({ type: "openSettings" });
                }}
              >
                <Icon name="gear" size={13} />
                <span>Settings</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

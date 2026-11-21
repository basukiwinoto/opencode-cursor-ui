/**
 * Sessions sidebar (Cursor-style): search, New Agent (⌘N), Customize,
 * day-grouped session list with status icon + title + meta, hover
 * rename/delete, and a bottom status bar with the update action.
 */
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactElement } from "react";
import type { SessionSummary } from "../../../shared/protocol";
import { postToHost } from "../vscodeApi";
import { useAppStore } from "../store";
import { cn, relativeTime } from "../utils";
import { Icon } from "./Icon";

interface DayGroup {
  label: string;
  sessions: SessionSummary[];
}

function dayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dayMs = 86_400_000;
  if (timestamp >= startOfToday) return "Today";
  if (timestamp >= startOfToday - dayMs) return "Yesterday";
  if (timestamp >= startOfToday - 6 * dayMs) {
    return date.toLocaleDateString(undefined, { weekday: "long" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function groupByDay(sessions: SessionSummary[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const session of sessions) {
    const label = dayLabel(session.updatedAt);
    const last = groups.at(-1);
    if (last && last.label === label) last.sessions.push(session);
    else groups.push({ label, sessions: [session] });
  }
  return groups;
}

export function SessionsSidebar({ onClose }: { onClose?: () => void }): ReactElement {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionID = useAppStore((s) => s.activeSessionID);
  const busySessions = useAppStore((s) => s.busySessions);
  const runtime = useAppStore((s) => s.runtime);
  const setView = useAppStore((s) => s.setView);
  const startNewChat = useAppStore((s) => s.startNewChatLocal);
  const openSessionLocal = useAppStore((s) => s.openSessionLocal);
  const applyRenameSession = useAppStore((s) => s.applyRenameSession);
  const applyDeleteSession = useAppStore((s) => s.applyDeleteSession);

  const [query, setQuery] = useState("");
  const [renamingID, setRenamingID] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmID, setConfirmID] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      sessions
        .filter((s) => !q || s.title.toLowerCase().includes(q))
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, q],
  );
  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  // Escape cancels inline confirms / rename.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setConfirmID(null);
        setRenamingID(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Refresh the session list from the host when the view opens.
  useEffect(() => {
    postToHost({ type: "listSessions" });
  }, []);

  const commitRename = (sessionID: string) => {
    const title = renameText.trim();
    if (title) {
      postToHost({ type: "renameSession", sessionID, title });
      applyRenameSession(sessionID, title);
    }
    setRenamingID(null);
  };

  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>, sessionID: string) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename(sessionID);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      setRenamingID(null);
    }
  };

  const resume = (sessionID: string) => {
    openSessionLocal(sessionID);
    postToHost({ type: "openSession", sessionID });
  };

  const newAgent = () => {
    startNewChat();
    postToHost({ type: "newChat" });
  };

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);

  return (
    <div className="sessions-sidebar">
      <div className="sessions-sidebar-head">
        <span className="sessions-sidebar-title">Sessions</span>
        {onClose && (
          <button type="button" className="icon-btn" aria-label="Close sessions sidebar" title="Close" onClick={onClose}>
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
      <div className="history-search">
        <Icon name="search" size={13} className="history-search-icon" />
        <input
          type="text"
          className="text-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search Agents…"
          aria-label="Search sessions"
        />
      </div>

      <div className="sessions-actions">
        <button type="button" className="sessions-action" onClick={newAgent}>
          <Icon name="filter" size={14} className="sessions-action-icon" />
          <span>New Agent</span>
          <span className="sessions-kbd">{isMac ? "⌘N" : "Ctrl+N"}</span>
        </button>
        <button
          type="button"
          className="sessions-action"
          onClick={() => {
            setView("control", { notifyHost: false });
            postToHost({ type: "openControlCenter" });
          }}
        >
          <Icon name="grid" size={14} className="sessions-action-icon" />
          <span>Customize</span>
        </button>
      </div>

      <div className="sessions-list" role="list">
        {groups.length === 0 && (
          <div className="screen-empty">{sessions.length === 0 ? "No conversations yet." : "No matching sessions."}</div>
        )}
        {groups.map((group) => (
          <div key={group.label} className="sessions-group">
            <div className="sessions-group-title">{group.label}</div>
            {group.sessions.map((session) => {
              const busy = session.busy || busySessions[session.id] === true;
              const active = session.id === activeSessionID;
              return (
                <div key={session.id} className={cn("sessions-row", active && "sessions-row-active")}>
                  {renamingID === session.id ? (
                    <input
                      type="text"
                      className="text-input history-rename"
                      value={renameText}
                      autoFocus
                      aria-label="Session title"
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => onRenameKeyDown(e, session.id)}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        className="sessions-row-main"
                        title={`Resume: ${session.title}`}
                        onClick={() => resume(session.id)}
                      >
                        <span className="sessions-row-icon">
                          {busy ? (
                            <Icon name="spinner" size={13} className="icon-spin" />
                          ) : (
                            <Icon name="check" size={13} className="sessions-check" />
                          )}
                        </span>
                        <span className="sessions-row-text">
                          <span className="sessions-row-title">{session.title}</span>
                          <span className="sessions-row-meta">
                            {session.model?.modelID ? `${session.model.modelID} · ` : ""}
                            {relativeTime(session.updatedAt)}
                          </span>
                        </span>
                      </button>
                      <span className="sessions-row-actions">
                        {confirmID === session.id ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-danger btn-mini"
                              onClick={() => {
                                postToHost({ type: "deleteSession", sessionID: session.id });
                                applyDeleteSession(session.id);
                                setConfirmID(null);
                              }}
                            >
                              Delete
                            </button>
                            <button type="button" className="btn btn-mini" onClick={() => setConfirmID(null)}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label={`Rename ${session.title}`}
                              title="Rename"
                              onClick={() => {
                                setRenamingID(session.id);
                                setRenameText(session.title);
                              }}
                            >
                              <Icon name="pencil" size={12} />
                            </button>
                            <button
                              type="button"
                              className={cn("icon-btn", "danger-hover")}
                              aria-label={`Delete ${session.title}`}
                              title="Delete"
                              onClick={() => setConfirmID(session.id)}
                            >
                              <Icon name="trash" size={12} />
                            </button>
                          </>
                        )}
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="sessions-footer">
        <div className="sessions-footer-info">
          <span className="sessions-footer-name">OpenCode</span>
          <span className="sessions-footer-sub">{runtime.version ? `v${runtime.version}` : runtime.state}</span>
        </div>
        {runtime.updateAvailable && (
          <button type="button" className="update-pill" onClick={() => postToHost({ type: "updateRuntime" })}>
            Update
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label="Open settings"
          title="Settings"
          onClick={() => postToHost({ type: "openSettings" })}
        >
          <Icon name="gear" size={14} />
        </button>
      </div>
    </div>
  );
}

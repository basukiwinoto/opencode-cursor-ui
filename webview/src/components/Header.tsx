/**
 * Compact Cursor-style header: app label, session title, runtime status dot,
 * and icon actions. Model/agent pickers hide below 380px (the composer
 * footer always carries them).
 */
import { postToHost } from "../vscodeApi";
import { useAppStore } from "../store";
import { cn } from "../utils";
import { Icon } from "./Icon";
import { AgentPicker, ModelPicker } from "./Pickers";

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

export function Header() {
  const runtime = useAppStore((s) => s.runtime);
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionID = useAppStore((s) => s.activeSessionID);
  const startNewChat = useAppStore((s) => s.startNewChatLocal);
  const setView = useAppStore((s) => s.setView);

  const activeSession = sessions.find((s) => s.id === activeSessionID);
  const dotClass = STATE_DOT_CLASS[runtime.state] ?? "dot-gray";
  const tooltip = [
    `OpenCode: ${runtime.state}`,
    runtime.version ? `v${runtime.version}` : undefined,
    runtime.detail,
    runtime.error,
  ]
    .filter(Boolean)
    .join(" · ");

  const onNewChat = () => {
    startNewChat();
    postToHost({ type: "newChat" });
  };

  return (
    <header className="header">
      <div className="header-brand">
        <Icon name="bolt" size={14} className="header-logo" />
        <span className="header-app-label">OpenCode</span>
        <span className={cn("status-dot", dotClass)} title={tooltip} />
      </div>

      <span className="header-title" title={activeSession?.title ?? "New chat"}>
        {activeSession?.title ?? "New chat"}
      </span>

      <div className="header-pickers">
        <ModelPicker className="picker-mini" />
        <AgentPicker className="picker-mini" />
      </div>

      <div className="header-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label="New chat"
          title="New chat"
          onClick={onNewChat}
        >
          <Icon name="plus" size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Chat history"
          title="History"
          onClick={() => setView("history")}
        >
          <Icon name="clock" size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Open runtime control center"
          title="Control Center"
          onClick={() => {
            setView("control", { notifyHost: false });
            postToHost({ type: "openControlCenter" });
          }}
        >
          <Icon name="gear" size={15} />
        </button>
      </div>
    </header>
  );
}

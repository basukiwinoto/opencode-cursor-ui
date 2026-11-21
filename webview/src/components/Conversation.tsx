/**
 * Scrollable message list with stick-to-bottom behavior, a "jump to latest"
 * pill, an empty welcome state, and inline pending permission cards.
 */
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { cn } from "../utils";
import { Icon } from "./Icon";
import { MessageView } from "./MessageView";
import { PermissionRequestCard } from "./PermissionRequest";

const BOTTOM_THRESHOLD_PX = 48;

const TIPS: string[] = [
  "Use @ to mention the active file or attach your selection.",
  "Ask for edits, refactors, or explanations — tools run inline.",
  "Approve or reject permission requests without leaving the sidebar.",
];

export function Conversation() {
  const messages = useAppStore((s) => s.messages);
  const showToolCalls = useAppStore((s) => s.showToolCalls);
  const permissions = useAppStore((s) => s.permissions);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const lastMessage = messages.at(-1);
  const lastSignature = lastMessage
    ? `${lastMessage.id}:${lastMessage.text.length}:${lastMessage.reasoning?.length ?? 0}:${lastMessage.tools.length}`
    : "";

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lastSignature, messages.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
    stickRef.current = atBottom;
    setShowJump(!atBottom);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  if (messages.length === 0 && permissions.length === 0) {
    return (
      <div className="conversation conversation-empty">
        <div className="empty-state">
          <Icon name="chat" size={28} className="empty-icon" />
          <h2 className="empty-title">Welcome to OpenCode</h2>
          <p className="empty-sub">Your agentic coding partner, right in the sidebar.</p>
          <ul className="empty-tips">
            {TIPS.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="conversation-wrap">
      <div className="conversation" ref={scrollRef} onScroll={onScroll}>
        {messages.map((message) => (
          <MessageView key={message.id} message={message} showToolCalls={showToolCalls} />
        ))}
        {permissions.map((request) => (
          <PermissionRequestCard key={request.requestID} request={request} />
        ))}
        <div className="conversation-spacer" />
      </div>
      <button
        type="button"
        className={cn("jump-latest", !showJump && "hidden")}
        onClick={jumpToLatest}
        aria-label="Jump to latest message"
      >
        <Icon name="chevron" size={12} />
        <span>Latest</span>
      </button>
    </div>
  );
}

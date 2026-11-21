/**
 * Single conversation message. User messages render as a right-aligned
 * bubble with attachment chips; assistant messages render markdown with a
 * streaming cursor, a collapsible Thinking section (auto-opens while
 * streaming, collapses on completion), tool-call rows, and a compact
 * cost/token footer.
 */
import { memo, useEffect, useRef, useState } from "react";
import type { AttachmentView, ChatMessage } from "../../../shared/protocol";
import { postToHost } from "../vscodeApi";
import { useAppStore } from "../store";
import { cn, copyText, formatCost, formatTokens, relativeTime } from "../utils";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { ToolCallRow } from "./ToolCall";

function AttachmentChip({ attachment }: { attachment: AttachmentView }) {
  const iconName =
    attachment.kind === "folder" ? "folder" : attachment.kind === "diagnostics" ? "alert" : "file";
  return (
    <button
      type="button"
      className="chip"
      title={attachment.uri}
      onClick={() => postToHost({ type: "openFile", path: attachment.uri })}
    >
      <Icon name={iconName} size={11} />
      <span>{attachment.name}</span>
    </button>
  );
}

/** Cursor-like reasoning disclosure: "Thinking…" while streaming, "Thought briefly" after. */
function ReasoningSection({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    if (streaming && text) {
      setOpen(true);
    } else if (wasStreaming.current && !streaming) {
      setOpen(false);
    }
    wasStreaming.current = streaming;
  }, [streaming, text]);

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const label = streaming ? "Thinking…" : words > 60 ? "Thought for a while" : "Thought briefly";

  return (
    <div className={cn("reasoning", open && "reasoning-open")}>
      <button
        type="button"
        className="reasoning-toggle"
        aria-expanded={open}
        title="Reasoning"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="reasoning-label">{label}</span>
        {streaming && <Icon name="spinner" size={11} className="icon-spin" />}
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  );
}

function AssistantFooter({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  const sessionID = useAppStore((s) => s.activeSessionID);
  const time = relativeTime(message.updatedAt ?? message.createdAt);
  const tooltip = [
    message.model ? `${message.model.providerID}/${message.model.modelID}` : undefined,
    message.tokens ? `tokens ↑${formatTokens(message.tokens.input)} ↓${formatTokens(message.tokens.output)}` : undefined,
    message.cost != null ? formatCost(message.cost) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="msg-footer" title={tooltip || undefined}>
      <span className="msg-footer-time">{time}</span>
      <button
        type="button"
        className="icon-btn msg-action"
        aria-label="Fork conversation from here"
        title="Fork: branch the conversation from this point into a new chat"
        onClick={() => {
          if (sessionID) postToHost({ type: "forkSession", sessionID, messageID: message.id });
        }}
      >
        <Icon name="fork" size={12} />
      </button>
      <button
        type="button"
        className="icon-btn msg-action"
        aria-label="Copy message"
        title="Copy"
        onClick={() => {
          void copyText(message.text).then((ok) => {
            if (ok) {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }
          });
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={12} />
      </button>
    </div>
  );
}

function UserMessageActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="msg-footer msg-footer-user">
      <button
        type="button"
        className="icon-btn msg-action"
        aria-label="Copy message"
        title="Copy"
        onClick={() => {
          void copyText(text).then((ok) => {
            if (ok) {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }
          });
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={12} />
      </button>
    </div>
  );
}

export interface MessageViewProps {
  message: ChatMessage;
  showToolCalls: boolean;
}

export const MessageView = memo(function MessageView({ message, showToolCalls }: MessageViewProps) {
  if (message.role === "user") {
    return (
      <div className="msg msg-user">
        <div className="msg-user-bubble">
          {message.attachments.length > 0 && (
            <div className="msg-attachments">
              {message.attachments.map((a, i) => (
                <AttachmentChip key={`${a.uri}-${i}`} attachment={a} />
              ))}
            </div>
          )}
          <div className="msg-user-text">{message.text}</div>
          <UserMessageActions text={message.text} />
        </div>
      </div>
    );
  }

  const showTools = showToolCalls && message.tools.length > 0;
  const waiting = message.streaming && !message.text && !message.reasoning;

  return (
    <div className={cn("msg msg-assistant", message.outcome === "failed" && "msg-failed")}>
      {message.reasoning ? (
        <ReasoningSection text={message.reasoning} streaming={message.streaming} />
      ) : null}

      {message.text ? (
        <div className="msg-text">
          <Markdown text={message.text} />
          {message.streaming && (
            <span className="stream-cursor" aria-hidden="true">
              ▍
            </span>
          )}
        </div>
      ) : waiting ? (
        <div className="msg-text msg-waiting">
          <Icon name="spinner" size={13} className="icon-spin" />
          <span>Working…</span>
        </div>
      ) : null}

      {showTools && (
        <div className="msg-tools">
          {message.tools.map((call) => (
            <ToolCallRow key={call.callID} call={call} />
          ))}
        </div>
      )}

      {message.outcome === "failed" && (
        <div className="error-banner" role="alert">
          <Icon name="alert" size={13} />
          <span>{message.error ?? "The request failed."}</span>
        </div>
      )}
      {message.outcome === "interrupted" && <span className="interrupted-chip">Interrupted</span>}

      <AssistantFooter message={message} />
    </div>
  );
});

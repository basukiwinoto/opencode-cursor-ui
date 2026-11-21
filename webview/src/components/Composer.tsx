/**
 * Composer: auto-growing textarea (Enter sends, Shift+Enter newline),
 * attachment chips from the editor context, @ mention, model/agent pickers
 * in the footer, Send / Stop, and an inline hint when the runtime is down.
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { postToHost } from "../vscodeApi";
import { draftKeyFor, useAppStore } from "../store";
import { cn } from "../utils";
import { Icon } from "./Icon";
import { AgentPicker, ModelPicker } from "./Pickers";
import { RuntimeHint } from "./RuntimeHint";

const MAX_TEXTAREA_HEIGHT = 190; // ~10 rows at 13px/19px line-height
const EMPTY_FILES: never[] = [];

/** Doc-comment preserved; agent pill sits left of the model selector (Cursor order). */
export function Composer() {
  const runtimeState = useAppStore((s) => s.runtime.state);
  const activeSessionID = useAppStore((s) => s.activeSessionID);
  const draft = useAppStore((s) => s.drafts[draftKeyFor(s.activeSessionID)] ?? "");
  const files = useAppStore((s) => s.draftFiles[draftKeyFor(s.activeSessionID)] ?? EMPTY_FILES);
  const busy = useAppStore((s) => (s.activeSessionID ? s.busySessions[s.activeSessionID] ?? false : false));
  const canStop = useAppStore((s) => s.canStop);
  const editorContext = useAppStore((s) => s.editorContext);

  const setDraft = useAppStore((s) => s.setDraft);
  const clearDraft = useAppStore((s) => s.clearDraft);
  const addDraftFile = useAppStore((s) => s.addDraftFile);
  const removeDraftFile = useAppStore((s) => s.removeDraftFile);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const running = runtimeState === "running";

  // Auto-grow up to ~10 rows, then scroll.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [draft]);

  const insertToken = (token: string) => {
    const el = textareaRef.current;
    const current = draft;
    const pos = el?.selectionStart ?? current.length;
    const before = current.slice(0, pos);
    const after = current.slice(pos);
    const gap = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const next = `${before}${gap}${token} ${after}`;
    setDraft(next);
    const caret = (before + gap + token + " ").length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const mentionActiveFile = () => {
    const file = editorContext?.activeFile;
    if (!file) return;
    addDraftFile({ name: file.name, uri: file.path, kind: "file" });
    insertToken(`@${file.name}`);
  };

  const attachSelection = () => {
    const selection = editorContext?.selection;
    if (!selection) return;
    addDraftFile({ name: `${selection.name} L${selection.startLine}`, uri: selection.path, kind: "selection" });
    insertToken(`@${selection.name}`);
  };

  const attachDiagnostics = () => {
    const count = editorContext?.diagnosticCount ?? 0;
    if (count <= 0) return;
    addDraftFile({
      name: `${count} problem${count === 1 ? "" : "s"}`,
      uri: editorContext?.activeFile?.path ?? "diagnostics",
      kind: "diagnostics",
    });
  };

  const send = () => {
    const text = draft.trim();
    if (!text || !running) return;
    postToHost({
      type: "sendMessage",
      text,
      files:
        files.length > 0
          ? files.map((f) => ({ uri: f.uri, name: f.name }))
          : undefined,
    });
    clearDraft();
  };

  const stop = () => {
    postToHost({ type: "stop", sessionID: activeSessionID });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const diagnosticCount = editorContext?.diagnosticCount ?? 0;

  return (
    <div className="composer">
      {files.length > 0 && (
        <div className="composer-chips" aria-label="Attached context">
          {files.map((f) => (
            <span key={`${f.uri}-${f.kind}`} className="chip">
              <Icon
                name={f.kind === "folder" ? "folder" : f.kind === "diagnostics" ? "alert" : "file"}
                size={11}
              />
              <span className="chip-name">{f.name}</span>
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${f.name}`}
                onClick={() => removeDraftFile(f.name)}
              >
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="composer-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={running ? "Plan, build, @ for context" : "OpenCode is not running"}
        rows={2}
        aria-label="Message OpenCode"
        readOnly={!running}
      />

      {!running && <RuntimeHint />}

      <div className="composer-bar">
        <div className="composer-modes">
          <AgentPicker className="picker-pill" />
          <ModelPicker className="picker-plain" />
        </div>

        <div className="composer-send">
          {diagnosticCount > 0 && (
            <button
              type="button"
              className={cn("icon-btn", "composer-problems")}
              aria-label={`Attach ${diagnosticCount} problems`}
              title={`Attach ${diagnosticCount} problems`}
              disabled={!running}
              onClick={attachDiagnostics}
            >
              <Icon name="alert" size={13} />
              <span className="problems-count">{diagnosticCount}</span>
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="Mention active file"
            title="Mention active file (@)"
            disabled={!running || !editorContext?.activeFile}
            onClick={mentionActiveFile}
          >
            <Icon name="at" size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Attach editor selection"
            title="Attach selection"
            disabled={!running || !editorContext?.selection}
            onClick={attachSelection}
          >
            <Icon name="paperclip" size={14} />
          </button>
          {(canStop || busy) && (
            <button
              type="button"
              className="icon-btn btn-stop"
              aria-label="Stop generating"
              title="Stop"
              onClick={stop}
            >
              <Icon name="stop" size={13} />
            </button>
          )}
          <button
            type="button"
            className="send-btn"
            aria-label="Send message"
            title="Send (Enter)"
            disabled={!running || draft.trim().length === 0}
            onClick={send}
          >
            <Icon name="send" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

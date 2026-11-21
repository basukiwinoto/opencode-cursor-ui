/**
 * Collapsible tool-call row: status icon, tool name, short title, chevron.
 * Expanded: pretty-printed input, scrollable output, red error, and a file
 * link that posts `openFile`.
 */
import { memo, useMemo, useState } from "react";
import type { ToolCallView } from "../../../shared/protocol";
import { postToHost } from "../vscodeApi";
import { basename, cn, truncate } from "../utils";
import { Icon } from "./Icon";

const MAX_INPUT_CHARS = 4000;
const MAX_OUTPUT_CHARS = 8000;

function StatusIcon({ status }: { status: ToolCallView["status"] }) {
  switch (status) {
    case "pending":
    case "running":
      return <Icon name="spinner" size={12} className="icon-spin tc-spin" />;
    case "success":
      return <Icon name="check" size={12} className="tc-ok" />;
    case "error":
      return <Icon name="x" size={12} className="tc-fail" />;
  }
}

function formatInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export const ToolCallRow = memo(function ToolCallRow({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const inputText = useMemo(() => formatInput(call.input), [call.input]);
  const file = call.file;

  return (
    <div className={cn("tool-call", `tc-${call.status}`, open && "tc-open")}>
      <button
        type="button"
        className="tool-call-head"
        aria-expanded={open}
        title={call.title ?? call.tool}
        onClick={() => setOpen((v) => !v)}
      >
        <StatusIcon status={call.status} />
        <span className="tool-call-name">{call.tool}</span>
        {call.title && <span className="tool-call-title">{truncate(call.title, 72)}</span>}
        <Icon name="chevron" size={11} className={cn("chev", open && "rot-90")} />
      </button>

      {open && (
        <div className="tool-call-body">
          {inputText && (
            <>
              <div className="tc-label">Input</div>
              <pre className="tc-pre">{truncate(inputText, MAX_INPUT_CHARS)}</pre>
            </>
          )}
          {call.output && (
            <>
              <div className="tc-label">Output</div>
              <pre className="tc-pre tc-output">{truncate(call.output, MAX_OUTPUT_CHARS)}</pre>
            </>
          )}
          {call.error && (
            <>
              <div className="tc-label tc-error-label">Error</div>
              <pre className="tc-pre tc-error">{call.error}</pre>
            </>
          )}
          {file && (
            <button
              type="button"
              className="tc-file"
              title={`Open ${file}`}
              onClick={() => postToHost({ type: "openFile", path: file })}
            >
              <Icon name="file" size={11} />
              <span>{basename(file)}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
});

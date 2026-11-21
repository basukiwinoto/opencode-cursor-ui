/**
 * Collapsible "Changes (n)" section shown above the composer: per-file rows
 * with status badge, +/- diffstat, diff link, and an optimistic reviewed
 * toggle. Hidden entirely when `showFileChanges` is off or there are none.
 */
import { useState } from "react";
import type { FileChangeView } from "../../../shared/protocol";
import { postToHost } from "../vscodeApi";
import { useAppStore } from "../store";
import { cn } from "../utils";
import { Icon } from "./Icon";

const STATUS_LABEL: Record<FileChangeView["status"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
};

function StatusBadge({ status }: { status: FileChangeView["status"] }) {
  return <span className={cn("fc-badge", `fc-${status}`)}>{STATUS_LABEL[status]}</span>;
}

export function FileChangesSection() {
  const changes = useAppStore((s) => s.fileChanges);
  const enabled = useAppStore((s) => s.showFileChanges);
  const toggleReviewed = useAppStore((s) => s.toggleFileReviewed);
  const [open, setOpen] = useState(true);

  if (!enabled || changes.length === 0) return null;

  const additions = changes.reduce((sum, c) => sum + c.additions, 0);
  const deletions = changes.reduce((sum, c) => sum + c.deletions, 0);

  return (
    <section className="file-changes" aria-label="File changes">
      <button type="button" className="fc-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="chevron" size={11} className={cn("chev", open && "rot-90")} />
        <span className="fc-title">Changes ({changes.length})</span>
        <span className="fc-diffstat">
          <span className="fc-add">+{additions}</span>
          <span className="fc-del">−{deletions}</span>
        </span>
      </button>

      {open && (
        <ul className="fc-list">
          {changes.map((change) => (
            <li key={change.path} className={cn("fc-row", change.reviewed && "fc-reviewed")}>
              <StatusBadge status={change.status} />
              <button
                type="button"
                className="fc-path"
                title={`Open diff: ${change.path}`}
                onClick={() => postToHost({ type: "openDiff", path: change.path })}
              >
                {change.path.split("/").pop()}
              </button>
              <span className="fc-diffstat">
                <span className="fc-add">+{change.additions}</span>
                <span className="fc-del">−{change.deletions}</span>
              </span>
              <button
                type="button"
                className={cn("icon-btn fc-review", change.reviewed && "fc-review-active")}
                aria-label={change.reviewed ? "Mark unreviewed" : "Mark reviewed"}
                aria-pressed={change.reviewed}
                title={change.reviewed ? "Mark unreviewed" : "Mark reviewed"}
                onClick={() => toggleReviewed(change.path)}
              >
                <Icon name="check" size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

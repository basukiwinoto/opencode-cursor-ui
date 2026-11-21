/**
 * Runtime log viewer: last 200 entries, level colors, monospace, auto-scroll
 * to the newest entry.
 */
import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { clockTime } from "../utils";

export function LogsPanel() {
  const logs = useAppStore((s) => s.logs);
  const logEndRef = useRef<HTMLDivElement>(null);
  const shown = logs.slice(-200);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [logs.length]);

  return (
    <section className="cc-logs" aria-label="Runtime logs">
      <div className="cc-logs-head">
        Logs <span className="cc-logs-count">(last {shown.length})</span>
      </div>
      <div className="cc-logs-body">
        {shown.length === 0 && <div className="log log-debug">No log entries yet.</div>}
        {shown.map((entry) => (
          <div key={entry.seq} className={`log log-${entry.level}`}>
            <span className="log-time">{clockTime(entry.time)}</span>
            <span className="log-msg">
              {entry.message}
              {entry.data ? ` ${entry.data}` : ""}
            </span>
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </section>
  );
}

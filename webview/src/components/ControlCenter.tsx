/**
 * Runtime Control Center — compact three-section layout:
 * OpenCode Config (server/state/version/provider/model/agent + config actions),
 * OpenCode Control (lifecycle buttons), OpenCode Logs.
 */
import { useState } from "react";
import { postToHost } from "../vscodeApi";
import { useAppStore } from "../store";
import { copyText, truncateMiddle } from "../utils";
import { Icon } from "./Icon";
import { LogsPanel } from "./LogsPanel";

function StateBadge({ state }: { state: string }) {
  return <span className={`state-badge state-${state}`}>{state}</span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="kv-row">
      <span className="kv-label">{label}</span>
      <span className="kv-value">{children}</span>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label="Copy"
      title="Copy"
      onClick={() => {
        void copyText(value).then((ok) => {
          if (ok) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }
        });
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={12} />
    </button>
  );
}

function ActionButton(props: {
  label: string;
  icon: Parameters<typeof Icon>[0]["name"];
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`btn btn-mini${props.primary ? " btn-primary" : ""}${props.danger ? " btn-ghost-danger" : ""}`}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      <Icon name={props.icon} size={12} />
      <span>{props.label}</span>
    </button>
  );
}

export function ControlCenter() {
  const runtime = useAppStore((s) => s.runtime);
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionID = useAppStore((s) => s.activeSessionID);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const selectedAgent = useAppStore((s) => s.selectedAgent);
  const configDefaultModel = useAppStore((s) => s.configDefaultModel);
  const configDefaultAgent = useAppStore((s) => s.configDefaultAgent);
  const setView = useAppStore((s) => s.setView);

  const activeSession = sessions.find((s) => s.id === activeSessionID);
  const running = runtime.state === "running" || runtime.state === "reconnecting";
  const notInstalled = runtime.state === "not_installed";
  const providerID = selectedModel?.providerID ?? configDefaultModel?.providerID;
  const modelLabel = selectedModel
    ? `${selectedModel.providerID}/${selectedModel.modelID}`
    : configDefaultModel
      ? `${configDefaultModel.providerID}/${configDefaultModel.modelID} (default)`
      : "—";

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="icon-btn" aria-label="Back to chat" title="Back" onClick={() => setView("chat")}>
          <Icon name="back" size={15} />
        </button>
        <h2 className="screen-title">Control Center</h2>
      </header>

      <section aria-label="OpenCode config">
        <div className="cc-section-title">OpenCode Config</div>
        <div className="cc-status">
          {runtime.serverUrl && (
            <div className="kv-row">
              <span className="kv-label">Server</span>
              <span className="kv-value" title={runtime.serverUrl}>
                {truncateMiddle(runtime.serverUrl, 34)}
              </span>
              <CopyButton value={runtime.serverUrl} />
            </div>
          )}
          <Row label="State">
            <StateBadge state={runtime.state} />
          </Row>
          <Row label="Version">
            {runtime.version ?? "—"}
            {runtime.updateAvailable && runtime.latestVersion ? ` → ${runtime.latestVersion} available` : ""}
          </Row>
          <div className="kv-row">
            <span className="kv-label">Provider</span>
            <span className="kv-value cc-inline-actions">
              <span title={providerID ?? undefined}>{providerID ?? "—"}</span>
              <button type="button" className="btn btn-mini" onClick={() => postToHost({ type: "setupProviderKey" })}>
                API key
              </button>
              <button type="button" className="btn btn-mini" onClick={() => postToHost({ type: "addProvider" })}>
                Custom
              </button>
            </span>
          </div>
          <div className="kv-row">
            <span className="kv-label">Model</span>
            <span className="kv-value cc-inline-actions">
              <span title={modelLabel}>{truncateMiddle(modelLabel, 30)}</span>
              <button type="button" className="btn btn-mini" onClick={() => postToHost({ type: "setDefaultModel" })}>
                {configDefaultModel ? "Change" : "Set default"}
              </button>
            </span>
          </div>
          <div className="kv-row">
            <span className="kv-label">Agent</span>
            <span className="kv-value cc-inline-actions">
              <span title={selectedAgent ?? configDefaultAgent ?? undefined}>
                {selectedAgent ?? configDefaultAgent ?? "—"}
              </span>
              <button type="button" className="btn btn-mini" onClick={() => postToHost({ type: "setDefaultAgent" })}>
                {configDefaultAgent ? "Change" : "Set default"}
              </button>
            </span>
          </div>
        </div>
      </section>

      <section aria-label="OpenCode control">
        <div className="cc-section-title">OpenCode Control</div>
        <div className="cc-actions">
          <ActionButton
            label={notInstalled ? "Install & start" : running ? "Restart" : "Start"}
            icon={running ? "refresh" : "bolt"}
            primary
            onClick={() => postToHost({ type: running ? "restartRuntime" : notInstalled ? "installRuntime" : "startRuntime" })}
          />
          <ActionButton
            label="Stop"
            icon="stop"
            danger
            disabled={!running}
            title={running ? "Stop the OpenCode runtime" : "Runtime is not running"}
            onClick={() => postToHost({ type: "stopRuntime" })}
          />
          <ActionButton label="Update" icon="bolt" onClick={() => postToHost({ type: "updateRuntime" })} />
          <ActionButton label="Disconnect" icon="external" onClick={() => postToHost({ type: "disconnect" })} />
          <ActionButton
            label="Select server"
            icon="file"
            title={runtime.mode === "external" ? "Connect to a server URL" : "Choose the OpenCode executable"}
            onClick={() => postToHost({ type: runtime.mode === "external" ? "connectExternal" : "selectExecutable" })}
          />
          <ActionButton label="Logs" icon="terminal" onClick={() => postToHost({ type: "openLogs" })} />
        </div>
      </section>

      <section aria-label="OpenCode logs">
        <div className="cc-section-title">OpenCode Logs</div>
        <LogsPanel />
      </section>
    </div>
  );
}

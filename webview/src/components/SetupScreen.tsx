/**
 * Setup screen: detection status, platform info, install flow with progress
 * bar, start/reconnect actions, troubleshooting details, and configuration
 * guidance (auth via `opencode auth login`, model selection).
 */
import { useEffect, useState } from "react";
import type { InstallProgress } from "../../../shared/protocol";
import { postToHost } from "../vscodeApi";
import { useAppStore } from "../store";
import { copyText, truncateMiddle } from "../utils";
import { Icon } from "./Icon";

const DETECTION_LABEL: Record<string, string> = {
  path: "Found on PATH",
  custom: "Custom executable",
  managed: "Managed install",
  none: "Not found",
};

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="kv-row">
      <span className="kv-label">{label}</span>
      <span className="kv-value" title={value}>
        {truncateMiddle(value, 60)}
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Copy ${label}`}
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
    </div>
  );
}

function InstallBar({ progress }: { progress: InstallProgress }) {
  const indeterminate = progress.percent == null;
  return (
    <div className="install-bar" role="status">
      <div className="install-bar-head">
        <Icon name="spinner" size={12} className={progress.phase === "done" ? undefined : "icon-spin"} />
        <span className="install-bar-msg">
          {progress.phase}
          {progress.message ? ` — ${progress.message}` : ""}
        </span>
        {progress.percent != null && <span className="install-bar-pct">{Math.round(progress.percent)}%</span>}
      </div>
      <div className={indeterminate ? "progress progress-indeterminate" : "progress"}>
        <div
          className="progress-fill"
          style={indeterminate ? undefined : { width: `${Math.min(100, Math.max(0, progress.percent ?? 0))}%` }}
        />
      </div>
    </div>
  );
}

export function SetupScreen() {
  const setup = useAppStore((s) => s.setup);
  const runtime = useAppStore((s) => s.runtime);
  const progress = useAppStore((s) => s.installProgress);
  const setView = useAppStore((s) => s.setView);

  const busy = runtime.state === "installing" || runtime.state === "updating" || runtime.state === "starting";
  const installed = setup?.installed ?? (runtime.state !== "not_installed" && runtime.state !== "error");
  const compatError = setup?.compatError;
  const detection = setup ? DETECTION_LABEL[setup.detection] ?? setup.detection : "Unknown";

  // Treat progress with phase "error" as blocking, "done" as clearing.
  const showProgress = progress && progress.phase !== "error" && busy;

  // Escape returns to chat.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setView("chat");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);

  return (
    <div className="screen setup-screen">
      <header className="screen-head">
        <button type="button" className="icon-btn" aria-label="Back to chat" title="Back" onClick={() => setView("chat")}>
          <Icon name="back" size={15} />
        </button>
        <h2 className="screen-title">Setup</h2>
        <button type="button" className="btn btn-mini" onClick={() => postToHost({ type: "openLogs" })}>
          <Icon name="terminal" size={12} />
          <span>Open Logs</span>
        </button>
      </header>

      <div className="setup-hero">
        <Icon
          name={installed && !compatError ? "check" : "alert"}
          size={30}
          className={installed && !compatError ? "setup-ok" : "setup-bad"}
        />
        <h1 className="setup-headline">
          {!installed
            ? "OpenCode is not installed"
            : compatError
              ? "OpenCode is not compatible"
              : `OpenCode ${runtime.version ?? setup?.version ?? ""} is ready`}
        </h1>
        <p className="setup-sub">
          {installed
            ? `${detection} · ${setup?.platform.os ?? "?"}/${setup?.platform.arch ?? "?"}`
            : "Install a managed runtime, or point the extension at an existing executable."}
        </p>
      </div>

      {compatError && (
        <div className="warn-box" role="alert">
          <Icon name="alert" size={13} />
          <span>{compatError}</span>
        </div>
      )}

      {runtime.error && (
        <div className="error-box" role="alert">
          <Icon name="alert" size={13} />
          <span>{runtime.error}</span>
        </div>
      )}

      {showProgress && progress && <InstallBar progress={progress} />}

      <div className="setup-actions">
        {!installed && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => postToHost({ type: "installRuntime" })}>
            <Icon name="bolt" size={13} />
            <span>{runtime.state === "installing" ? "Installing…" : "Install OpenCode"}</span>
          </button>
        )}
        {installed && (runtime.state === "stopped" || runtime.state === "error") && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => postToHost({ type: "startRuntime" })}>
            <Icon name="bolt" size={13} />
            <span>Start OpenCode</span>
          </button>
        )}
        {runtime.state === "reconnecting" && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => postToHost({ type: "reconnect" })}>
            <Icon name="refresh" size={13} />
            <span>Reconnect now</span>
          </button>
        )}
        {installed && runtime.state === "running" && (
          <button type="button" className="btn" onClick={() => setView("chat")}>
            <Icon name="chat" size={13} />
            <span>Start chatting</span>
          </button>
        )}
      </div>

      <details className="setup-details">
        <summary>Troubleshooting</summary>
        <div className="setup-kv">
          <CopyRow label="Executable" value={setup?.executablePath ?? "not detected"} />
          {setup?.managedExecutablePath && (
            <CopyRow label="Managed path" value={setup.managedExecutablePath} />
          )}
          <div className="kv-row">
            <span className="kv-label">Min version</span>
            <span className="kv-value">{setup?.minRequiredVersion ?? "—"}</span>
          </div>
          {setup?.latestVersion && (
            <div className="kv-row">
              <span className="kv-label">Latest</span>
              <span className="kv-value">{setup.latestVersion}</span>
            </div>
          )}
          <div className="kv-row">
            <span className="kv-label">Platform</span>
            <span className="kv-value">
              {setup?.platform.os ?? "?"}/{setup?.platform.arch ?? "?"}
              {setup?.platform.isRemote ? ` · remote: ${setup.platform.remote ?? "unknown"}` : ""}
            </span>
          </div>
          {setup?.installHint && (
            <div className="kv-row">
              <span className="kv-label">Hint</span>
              <span className="kv-value">{setup.installHint}</span>
            </div>
          )}
          {runtime.detail && (
            <div className="kv-row">
              <span className="kv-label">Detail</span>
              <span className="kv-value">{runtime.detail}</span>
            </div>
          )}
        </div>
        <button type="button" className="btn btn-mini" onClick={() => postToHost({ type: "openLogs" })}>
          Open Logs
        </button>
      </details>

      <section className="setup-guidance">
        <h3>Configuration</h3>
        <div className="setup-config-actions">
          <button type="button" className="btn btn-primary btn-mini" onClick={() => postToHost({ type: "setupProviderKey" })}>
            Connect provider (API key)
          </button>
          <button type="button" className="btn btn-mini" onClick={() => postToHost({ type: "addProvider" })}>
            Add custom provider
          </button>
        </div>
        <ul>
          <li>
            Prefer the terminal? Run <code>opencode auth login</code> instead, then restart the runtime here.
          </li>
          <li>Pick a model and agent from the composer footer before sending your first message.</li>
          <li>
            To use an already-running server, switch the <code>opencodeCursorUI.runtime.mode</code> setting to{" "}
            <code>external</code> and set its URL.
          </li>
        </ul>
      </section>
    </div>
  );
}

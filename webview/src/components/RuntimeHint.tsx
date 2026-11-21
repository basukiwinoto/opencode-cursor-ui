/**
 * Inline runtime hint shown by the composer when OpenCode is not running,
 * with a contextual action (Setup / Start).
 */
import { postToHost } from "../vscodeApi";
import { useAppStore } from "../store";
import { Icon } from "./Icon";

export function RuntimeHint() {
  const state = useAppStore((s) => s.runtime.state);
  const error = useAppStore((s) => s.runtime.error);
  const setView = useAppStore((s) => s.setView);

  let message: string;
  let action: { label: string; onClick: () => void } | undefined;

  switch (state) {
    case "not_installed":
      message = "OpenCode is not installed.";
      action = { label: "Setup", onClick: () => setView("setup") };
      break;
    case "stopped":
      message = error ?? "OpenCode is stopped.";
      action = { label: "Start", onClick: () => postToHost({ type: "startRuntime" }) };
      break;
    case "starting":
      message = "Starting OpenCode…";
      break;
    case "reconnecting":
      message = "Reconnecting to OpenCode…";
      break;
    case "installing":
      message = "Installing OpenCode…";
      break;
    case "updating":
      message = "Updating OpenCode…";
      break;
    case "error":
      message = error ?? "OpenCode hit an error.";
      action = { label: "Setup", onClick: () => setView("setup") };
      break;
    default:
      message = "OpenCode is not running.";
      action = { label: "Setup", onClick: () => setView("setup") };
  }

  return (
    <div className="runtime-hint" role="status">
      <Icon name="alert" size={12} />
      <span className="runtime-hint-msg">{message}</span>
      {action && (
        <button type="button" className="btn btn-mini" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

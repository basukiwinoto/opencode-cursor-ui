/**
 * Inline permission-request card with distinct accent border.
 * Buttons: Allow once / Always allow (when offered) / Reject.
 */
import type { PermissionRequestView } from "../../../shared/protocol";
import { useAppStore } from "../store";
import { truncateMiddle } from "../utils";
import { Icon } from "./Icon";

export function PermissionRequestCard({ request }: { request: PermissionRequestView }) {
  const reply = useAppStore((s) => s.replyPermission);
  const canAlways = request.saveScopes.includes("always");

  return (
    <div className="perm-card" role="alertdialog" aria-label={request.title}>
      <div className="perm-head">
        <Icon name="alert" size={14} className="perm-icon" />
        <span className="perm-title">{request.title}</span>
        <span className="perm-action">{request.action}</span>
      </div>

      {request.message && <p className="perm-message">{request.message}</p>}

      {request.resources.length > 0 && (
        <ul className="perm-resources">
          {request.resources.map((resource, i) => (
            <li key={`${resource}-${i}`} title={resource}>
              <Icon name="file" size={11} />
              <span>{truncateMiddle(resource, 64)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="perm-actions">
        <button
          type="button"
          className="btn btn-primary btn-mini"
          onClick={() => reply(request.requestID, request.sessionID, "once")}
        >
          Allow once
        </button>
        {canAlways && (
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => reply(request.requestID, request.sessionID, "always")}
          >
            Always allow
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost-danger btn-mini"
          onClick={() => reply(request.requestID, request.sessionID, "reject")}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

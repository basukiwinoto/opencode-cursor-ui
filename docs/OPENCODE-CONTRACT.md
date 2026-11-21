# OpenCode Integration Contract (verified ground truth)

Verified on **2026-11-20** against **OpenCode v2.2.6** (homebrew, `/opt/homebrew/bin/opencode`) and
**`@opencode/client@2.3.2`** (npm). Everything below was executed against a live server and
cross-checked against the installed SDK type declarations — where the .d.ts disagreed with early
live probing, the .d.ts won (discrepancies are listed in §10). Do not invent endpoints or fields
beyond this. Reference: official OpenAPI 3.1 spec at
`https://opencode.ai/docs/openapi.json` (copy + digest: `/private/var/folders/m0/x62rk74j16108x4w6cf8cgz00000gn/T/opencode/ocu/openapi.json`, `schema-digest.json`).

## 1. CLI

- Binary: `opencode`. Version: `opencode --version` → `opencode v2.2.6`.
- Subcommands include: `serve`, `upgrade` (alias `update`), `uninstall`, `auth`, `models`, `run`,
  `session`, `service`, `pair`, `api`, `mini`, `acp`.
- `opencode serve` — starts the v2 API + web server. Flags:
  - `--hostname <string>`, `--port <integer>`, `--cors <origin>` (repeatable),
    `--service` (register as the shared local service), `--stdio`, plus globals
    `--log-level <level>` and `--print-logs`.
- On startup the server prints **two lines to stdout**:
  - `server listening on http://127.0.0.1:<port>`
  - `server password <token>`  ← single-line, whitespace-delimited token (43 chars observed)
- The server's working directory becomes its default location; per-request locations can also be
  passed explicitly (see Locations).

## 2. Authentication (REQUIRED)

All `/api/*` routes return `401 {"_tag":"UnauthorizedError","message":"Authentication required"}`
without auth. The scheme is **HTTP Basic**, not Bearer:

```
Authorization: Basic base64("opencode:" + password)
```

- username: the literal string `opencode`
- password: the token printed as `server password <token>` (or from the service registration file)

Verified: Basic auth with `opencode:<token>` → 200. Bearer → 401. Empty username → 401.

## 3. Service registration (shared local service)

`opencode serve --service` registers itself in `~/.local/state/opencode/service.json`:

```json
{ "id": "…", "version": "2.2.6", "url": "http://127.0.0.1:49374", "pid": 4431, "password": "…" }
```

`@opencode/client/promise/service` exports `discover()`, `ensure()`, `stop()`, `headers(endpoint)`,
`fallback()` (default registration file path). Default ensure command: `opencode serve --service`.

## 4. Official client (`@opencode/client`)

```ts
import { OpenCode } from "@opencode/client";

const client = OpenCode.make({ baseUrl, headers?: Record<string, string>, fetch?: typeof fetch });
// per-call options: { signal?: AbortSignal, headers?: HeadersInit, onActivity?: () => void }
```

Client groups (verified in `dist/promise/generated/client.d.ts`):

| Group | Methods used by this extension |
|---|---|
| `server` | `info()` → `{version, pid, hostname, urls[], paths, capabilities}` |
| `session` | `list()`, `create({title?, agent?, model?, location?, permissions?})`, `get({sessionID})`, `update({sessionID, title?})`, `remove({sessionID})`, `prompt(SessionPromptInput)`, `interrupt({sessionID})`, `compact`, `fork`, `move`, `diff`, `context`, `model({sessionID, providerID, modelID, variant?})`, `agent({sessionID, agentID})` |
| `message` | `list({sessionID, limit?, order?, cursor?, type?})` |
| `agent` | `list()`, `get({agentID})` |
| `provider` | `list()`, `get({providerID})` |
| `model` | `list()`, `default()` |
| `permission` | `request.list()`, `saved.list/update/remove`, and per-session `session.permission.list/create/get`, `permission/{requestID}/reply` |
| `event` | `subscribe({types?}?)` → `AsyncIterable<V2Event>` |
| `config` | `get()` |
| `vcs` | `get`, `status`, `diff`, `branches` |

### Prompt input (verified `SessionPromptInput`)

```ts
{
  sessionID: string;
  text: string;
  id?: string | null;
  files?: Array<{ uri: string; source?: {type:"inline"}|{type:"uri", uri:string}; name?: string; description?: string; mention?: {start,end,text} }>;
  agents?: Array<{ name: string; mention?… }>;
  skills?: Array<{ id: string; mention?… }>;
  metadata?: Record<string, JsonValue>;
  delivery?: "steer" | "queue" | null;
  resume?: boolean | null;
}
```

### Permission reply (verified `PermissionReplyInput`)

```ts
{ sessionID: string; requestID: string; decision: "once" | "always" | "reject"; message?: string }
```

### List responses

All list endpoints return `{ location: {directory}, data: T[], cursor?: {previous,next} }`
(message list: `{ data, cursor }`).

### Session.Info (verified fields)

`{ id: "ses_…", projectID, title, agent?, model?: {providerID, id, variant}, cost, tokens, outcome?, time: {created, updated, busy?, idle?}, location: {directory} }`

### Model.Info (verified)

`{ id, modelID, providerID, type: "chat"|…, name, family?, package, settings: {apiKey?, baseURL?, …}, capabilities }`
⚠️ `settings.apiKey` contains the user's **real provider key** — REDACT before display/logging.

### Provider.Info (verified)

`{ id, integrationID, name, activation: "enabled"|"auto"|…, package, settings }`

### Permission.Request (verified)

`{ id, sessionID, action, resources: string[], save: string[] (scopes offered), metadata?, source?, message? }`

## 5. Events (`GET /api/event`, SSE)

Envelope: `{ id: EventID, created: number, type: string, location?, data: …, durable? }`.
First event on subscribe: `server.connected`.

Event types consumed by this extension (verified `data` shapes):

- `session.text.started | session.text.delta | session.text.ended` →
  `data: { sessionID, assistantMessageID, delta?/text? }` (delta carries incremental text)
- `session.reasoning.started | delta | ended` → same shape for reasoning text
- `session.tool.called` → `data: { sessionID, assistantMessageID, callID, tool, title? }`
- `session.tool.input.started | input.delta | input.ended` → `data: { sessionID, callID, input? }`
- `session.tool.progress` → `data: { sessionID, callID, output? }`
- `session.tool.success | session.tool.failed` → `data: { sessionID, callID, output?, error?, metadata? }`
- `session.created | session.renamed | session.metadata.updated | session.deleted` → session payload in `data.info`
- `session.idle` → `data: { sessionID }`
- `session.execution.started | succeeded | failed | interrupted` → `data: { sessionID, error? }`
- `session.usage.updated` → `data: { sessionID, cost?, tokens? }`
- `permission.asked` → `data: Permission.Request` (see §4)
- `permission.replied` → `data: { sessionID, requestID, decision }`
- `filesystem.changed` → `data: { file, event: "add"|"change"|"unlink" }`
- `installation.update-available` → `data: { version }`
- `location.shutdown` → server/location going down
- `session.status` → `SessionStatus = {type:"idle"} | {type:"retry", attempt, message} | {type:"busy"} | …`

Full union: `V2Event` in `@opencode/client/dist/promise/generated/types.d.ts`.

## 6. Locations

The server is location-scoped. `LocationPublicRef = { directory: <absolute path> }`.
Requests accept an optional `location: { directory }` to target a workspace; the server defaults to
its own cwd. This extension passes `location: { directory: <workspace root> }` where supported and
starts managed servers with cwd = workspace root.

## 7. Session diff (file changes)

`client.session.diff({ sessionID, messageID? })` → `FileDiff.Info[]`:
`{ file, patch (unified), additions, deletions, status: "added"|"deleted"|"modified", more? }`.

## 8. Known sensitive values

- Server password (Basic auth credential) — hold in memory only; never log; never send to webview.
- `model.settings.apiKey` / `provider.settings.apiKey` — redact everywhere.
- Authorization headers — redact.

## 9. Unsupported / do-not-use

- Do not use v1 endpoints (`/session`, `/event` without `/api` prefix) — v2 server exposes `/api/*`.
- Do not guess routes not listed here; check the OpenAPI spec first.

## 10. SDK `.d.ts` corrections to the early probe (authoritative)

Cross-checking `@opencode/client@2.3.2/dist/promise/generated/*.d.ts` against the live probe
corrected these details. The adapter implements the `.d.ts` shapes and tolerates both generations:

1. Model switching is `session.switchModel({ sessionID, model: { id, providerID, variant? } })` —
   there is no `session.model()`; the model field is `id`, not `modelID`.
2. Tool events are keyed by **`id`** (not `callID`). `session.tool.called` carries
   `{ id, input, executed }` with no tool name/title; the tool **name arrives on
   `session.tool.input.started` as `name`**. `tool.progress` has `metadata` (no `output`);
   `tool.success/failed` carry `content: [{type:"text",text}]` and a structured
   `error {type, message}` instead of plain strings. Schemas accept both shapes.
3. `permission.replied` uses `reply` (not `decision`).
4. `session.created` data is flat (no `data.info`, no `time` in the payload) — fall back to the
   envelope `created` for timestamps. `data.info` is still tolerated when present.
5. `session.text.started` has no `delta`. `session.usage.updated` fields are required; there is also
   `session.usage.recorded`.
6. Message model: user messages carry top-level `text` + `files` (base64 attachments); assistant
   content lives in `content` parts; tool part statuses are `streaming|running|completed|error`
   (there is no `pending`).
7. The SDK throws two error kinds: plain tagged objects (`{_tag:"UnauthorizedError"|"SessionBusyError"|…}`)
   for declared statuses and `ClientError` (Error subclass with `reason: "Transport"|…`) for
   transport issues. `server.connected` events omit `created`.
8. Zod-normalized tool events may fan out (one raw event → multiple normalized events); consumers of
   `mapV2Event` must accept `NormalizedEvent | NormalizedEvent[] | null`.
9. `session.usage.*` events are folded into `session.updated` partials — merge by session id, title
   empty string means "unchanged".
10. `session.status(idle)` → normalized `session.busy{busy:false}`; `execution.started` →
    `session.busy{busy:true}`; execution outcomes → `session.idle{outcome}`.

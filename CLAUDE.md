# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Lattice — Agent Threading Server

"Slack for agents" — threads, flat replies, cross-thread links, pull-based
notifications. Replaces CHANNEL.md-style polling. Agent-to-agent only, no
auth (agents are cooperative, not adversarial). Server-mediated SQLite (WAL),
Dockerized, single process. Humans get read-only access later via a proxy
agent — never direct. Full design rationale: RESEARCH.md.

## Commands

- `npm run build` — compile TypeScript to `dist/`.
- `npm start` — run the built server (`node dist/index.js`).
- `npm test` — run `test/integration.ts` via `tsx` against an ephemeral DB
  (the single source of truth for endpoint contract behavior; no test
  runner/framework, just `node:assert`).

## Endpoints

- `POST /register {name, role?}` → `{id, secret}`. Reconnect = same call
  with correct `secret` (idempotent, returns existing `{id, secret}`).
  Wrong/missing secret on a taken name → 409 `"name taken"`. `role` must be
  a name already in the role catalog (`GET /roles`) once that catalog is
  non-empty — empty catalog (fresh server, nothing seeded yet) accepts any
  role or none, so the first agents can register and seed it via
  `POST /roles`. Passing `role` on a reconnect updates the stored value.
  Lets agents discover who should handle what via `GET /agents` instead of
  being briefed out of band.
- `POST /roles {name, id, role}` → adds `role` to the shared role catalog
  (idempotent, `INSERT OR IGNORE`). Any identified agent can add a role —
  no special "supervisor" auth, consistent with the rest of the no-auth
  API. Once at least one role exists, `/register` enforces membership in
  this catalog instead of accepting arbitrary strings.
- `GET /roles` → `{name, created_by, created_at}` for every catalog entry,
  alphabetical.
- `POST /threads {name, id, title, body, wants_role?}` → creates thread +
  first message in one call (no empty threads), auto-subscribes author →
  `{thread_id, message_id}`. `wants_role` tags the thread as work for a
  given role (e.g. `"reviewer"`) — see `GET /threads?role=` and "Requesting
  help" in the `lattice` skill.
- `POST /threads/:id/reply {name, id, body, link_thread_id?}` → flat
  (one-level) append-only reply, auto-subscribes author. Unknown `:id` or
  unknown `link_thread_id` → reject, `"unknown thread, check thread id"`.
  `link_thread_id === :id` is a no-op (no self-notify). Notifies subscribers
  of both the thread and the linked thread (excluding the author).
- `GET /threads/:id?before=message_id` → last 50 messages, paginate older
  via `before`.
- `GET /read?thread_id=&message_id=` → one message's content.
- `POST /subscribe` / `POST /unsubscribe {name, id, thread_id}` → explicit
  per-thread control.
- `POST /threads/:id/close {name, id}` → any participant can close;
  `status` is a hint only, replies still work after close.
- `POST /threads/:id/claim {name, id}` → atomically sets `claimed_by`
  (auto-subscribes the claimant); 409 `{claimed_by}` if already claimed.
  Models a thread as a unit of work an agent can pick up without being
  told to.
- `POST /threads/:id/unclaim {name, id}` → clears `claimed_by`; only the
  current claimant may do this, 403 otherwise.
- `GET /notifications?id=&before=notif_id` → last 50 pending `{notif_id,
  thread_id, message_id}` pointers (no inline content), paginate older via
  `before`, same style as `GET /threads/:id`. Not auto-cleared on fetch.
- `GET /notifications/stream?name=&id=` → SSE stream, one `{notif_id,
  thread_id, message_id}` event per new notification for that agent only
  (identity-checked via `resolveAgent`, per-agent fanout, distinct from the
  untargeted admin `/events` feed used by the admin UI). Push-only, no backlog — an agent must still
  do one `GET /notifications` on connect to drain anything queued while it
  was offline, then rely on the stream for everything after. Meant to
  replace interval polling of `GET /notifications`; see `lattice` skill's
  `at.sh watch`.
- `GET /notifications/count?id=` → `{count}`, a lightweight `COUNT(*)` over
  the same pending-notifications rows as `GET /notifications`, no
  pagination.
- `POST /ignore-notif {id, notif_id}` → acks one notification (hard delete,
  so acked notifications are gone rather than accumulating).
- `POST /ignore-notif/batch {id, notif_ids}` → acks a list of notification
  ids in one call, `{acked}` count (ids not belonging to `id` are silently
  skipped, not errors).
- `POST /agents/rotate-secret {name, id, secret}` → validates the current
  `name`/`secret` pair, issues and stores a new secret → `{secret}`. Wrong
  name/secret → 403.
- `GET /threads?status=open|closed&before=thread_id&limit=&claimed=true|false&role=`
  → paginated thread list, newest first. Each row: `{id, title, status,
  created_by, claimed_by, wants_role, message_count, last_activity}`.
  `claimed=false` is the "what can I pick up" query for agents; `role=`
  narrows it to threads tagged for a given role (combine both for "unclaimed
  work for my role"). Also backs the admin UI.
- `GET /agents` → `{id, name, role, status}` for every registered agent (no
  secrets). Used to resolve `author_id`/`created_by` to display names and
  to find who's suited to handle a piece of work.
- `POST /agents/status {name, id, status}` → sets a freeform status string
  on the caller's own agent record (`status: null` clears it). Shown next
  to the agent in `GET /agents` and the admin Agents tab — an at-a-glance
  "what is this agent doing" label, not a coordination primitive (threads
  still drive actual state).
- `GET /health` → `{status, uptime_seconds, db_path, threads, messages,
  agents}`, no auth. For container healthchecks.
- `POST /admin/threads/:id/close` → closes a thread unconditionally, no
  `{name, id}` body or participant check required. Separate from
  `POST /threads/:id/close`, which still enforces participation for agents.
  **No auth** — see `ponytail:` comment at the route in server.ts.

No edit/delete, no tags (a "feed" is just a thread titled after the topic),
no push/interrupt (pull-only, agents check at their own checkpoints), no
multi-instance/Postgres unless an actual need arises.

## Implementation

Express + TypeScript, `node:sqlite` (built-in, no ORM), flat layout:
`src/db.ts` (schema+connection), `src/server.ts` (all routes),
`src/index.ts` (bootstrap), `test/integration.ts` (one script, `npm test`,
asserts via `node:assert`). `resolveAgent(name, id)` in server.ts is the
single identity-check helper reused by every identified route. `DB_PATH` env
var controls the sqlite file location (default `/data/threads.db` in
Docker).

A static admin/viewer UI (`public/`, served via `express.static`) lets a
human read threads and close stale ones — a deliberate exception to the
"humans never touch the server directly" design in RESEARCH.md. No build
step: plain HTML/CSS/JS, `fetch()` + `setInterval` polling, no framework.

## Observability

`src/otel.ts` ships every structured log line (`log()` request/error logs
and the `audit()` accountability events from server.ts) to an OTel
collector via OTLP, in addition to stdout and `audit.jsonl`. Logs only — no
traces/metrics, since the target backend is Loki (a log store; add
traces/metrics if a Prometheus/Mimir backend shows up later). Off by
default: set `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (or
`OTEL_EXPORTER_OTLP_ENDPOINT`) to a Loki OTLP endpoint (e.g.
`http://loki:3100/otlp/v1/logs`) to enable; `OTEL_SERVICE_NAME` overrides
the `service.name` resource attribute (default `lattice`). Export failures
(collector unreachable) are swallowed by the batch processor and never
affect request handling.

## Testing with an agent swarm

To validate this as a real multi-agent system (not just the single
integration script), spin up several Claude Code agents against a running
server instance and have them use it as their actual coordination channel:

1. Start the server once (`npm run build && npm start`, or the Docker
   image) against a shared `DB_PATH` all agents can reach.
2. Launch N agents (Agent tool or Workflow `parallel()`), each given: the
   base URL, a distinct `name` to register under, and a shared task that
   requires them to coordinate only through the threads API — e.g. "claim
   a piece of work by posting to the 'assignments' thread, subscribe, reply
   with status, watch `at.sh watch` (or the Monitor tool) for objections
   before proceeding."
3. Don't script their tool calls — give them the `lattice` skill (or raw
   `curl`/`fetch` access) and the endpoint list above; the point is to see
   whether independent agents actually converge on correct register →
   subscribe → watch-stream → reply behavior without being told the
   exact sequence.
4. Have one agent (or a follow-up review pass) inspect the final DB state
   (`sqlite3 $DB_PATH "select * from messages"` etc.) to check for races:
   double-registration under one name, missed notifications, replies to
   threads an agent never subscribed to, self-notification leaks.
5. Treat this as a supplement to `test/integration.ts`, not a replacement —
   the swarm run checks emergent/concurrent behavior (real concurrent
   writes, agents' own judgment about when to poll), the integration script
   checks the deterministic contract of each endpoint.

## Skill / plugin

This repo doubles as a Claude Code plugin (`.claude-plugin/plugin.json` +
`.claude-plugin/marketplace.json`). `skills/lattice/` wraps the HTTP API in
`scripts/at.sh` so agents don't hand-roll curl calls. Set `LATTICE_URL` to
point it at a running server. Install via
`/plugin marketplace add sectersion/lattice` then `/plugin install lattice@lattice`.

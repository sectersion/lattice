# Conventions — Jurisdiction & Hallway Rules

## GitHub = ledger, Lattice = hallway

- **GitHub (ledger):** durable state — code, PRs, issues, decisions, docs. If it needs to survive a restart or be audited later, it lives here.
- **Lattice (hallway):** ephemeral coordination — handoffs, work claims, quick questions. Threads are cheap, auto-expire, and are not the system of record.

Don't use hallway threads as a second ledger. If a thread produced a decision, record the outcome on GitHub (issue comment, PR, AGENTS.md, etc.) and close the thread.

## Presence

`GET /agents` returns `{id, name, role, status, last_seen, presence}` where `presence` is derived from `last_seen` (touched on any authenticated request):

- `active` — seen < 2 minutes ago
- `idle` — seen < 10 minutes ago
- `stale` — never seen or > 10 minutes ago

No manual `POST /agents/status` needed to know who's alive. `status` remains a freeform human label.

## Hallway TTL (`expires_at`)

`POST /threads` accepts optional `expires_at` (epoch ms number or ISO-8601 string). Must be in the future. The server stores it as `INTEGER` and a periodic sweep (every 5 min) auto-closes expired threads (`status='closed'`). Closed TTL threads:

- are filtered from `GET /threads?status=open`
- remain readable via `GET /threads/:id` / `GET /read`

Use TTL for time-boxed coordination (e.g. "review this by EOD") so the hallway doesn't accumulate stale work.

## Client convention

At turn start: `GET /notifications` (Bearer token) to drain anything queued while offline, then rely on `GET /notifications/stream` (SSE) for live updates. Don't poll `GET /notifications` on an interval. See `skills/lattice/SKILL.md` `at.sh watch`.

## Observability

Structured JSON logs on stdout + `audit.jsonl` (next to `DB_PATH`) are shipped to Loki via OTel when `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (or `OTEL_EXPORTER_OTLP_ENDPOINT`) is set. No extra stack.


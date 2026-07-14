# Agent Threading Server — Implementation Plan

## Context

RESEARCH.md specs a "Slack for agents" server: threads, flat replies,
cross-thread links, and pull-based notifications, replacing an ad-hoc
CHANNEL.md polling pattern. Repo is currently empty (just README.md and
RESEARCH.md). Building from scratch per the confirmed stack: Node/TypeScript
+ Express, SQLite (WAL) via `node:sqlite` (built-in, Node 22+) or
`better-sqlite3` if `node:sqlite` proves awkward, auto-increment integer IDs,
random hex secrets, single integration-test script for verification.

## Stack & structure

- Express + TypeScript, single process, Dockerized.
- SQLite WAL mode, one file, accessed only by this server (no ORM — plain
  `db.prepare(...).run/get/all` calls, this schema is small enough that an
  ORM is pure overhead).
- Flat file layout (no need for src/routes/src/models split at this size):
  - `src/db.ts` — schema init + connection (WAL pragma, foreign_keys on)
  - `src/server.ts` — Express app + all route handlers
  - `src/index.ts` — bootstrap (listen)
  - `test/integration.ts` — the one runnable check (spins up server on a
    temp port + temp db file, exercises golden path + rejects)
  - `Dockerfile`
  - `package.json`, `tsconfig.json`

## Schema (SQLite)

```sql
CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  secret TEXT NOT NULL
);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_by INTEGER NOT NULL REFERENCES agents(id)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  author_id INTEGER NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL,
  link_thread_id INTEGER REFERENCES threads(id),
  created_at INTEGER NOT NULL -- unix ms, set by server at insert time
);

CREATE TABLE subscriptions (
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  PRIMARY KEY (thread_id, agent_id)
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  message_id INTEGER NOT NULL REFERENCES messages(id),
  acked INTEGER NOT NULL DEFAULT 0
);
```

`GET /notifications` filters `acked = 0`; `/ignore-notif` sets `acked = 1`
(no need for a separate ack table or deletion — one flag is the whole
mechanism).

## Auth pattern

No auth/permissions on identified requests — spec is explicit that MVP has
none, agents are cooperative not adversarial. Every mutating/identified
request carries `{name, id}` only. A single `resolveAgent(name, id)` helper
in `server.ts` does the lookup (404/400 on unknown `id`, or if `name`
doesn't match that `id`'s row — a client bug, not an auth failure), reused
by every handler that needs identity (`reply`, `subscribe`, `unsubscribe`,
`close`, thread create). `secret` is checked in exactly one place:
`/register`, to gate reconnecting under an existing `name`.

## Endpoints (per RESEARCH.md, mapped 1:1)

- `POST /register {name}` → creates or returns existing `{id, secret}`
  - existing name + correct `secret` in body → idempotent return
  - existing name + missing/wrong secret → 409 `"name taken"`
  - Note: first registration has no secret to check yet — request body for
    *first-time* register is just `{name}`; reconnect path is
    `{name, secret}` and the server checks it against the stored value.
- `POST /threads {name, id, title, body}` → inserts thread + first
  message in one transaction, auto-subscribes author, returns
  `{thread_id, message_id}`
- `POST /threads/:id/reply {name, id, body, link_thread_id?}`
  - reject unknown `:id` or unknown `link_thread_id` (if present) with
    `"unknown thread, check thread id"`
  - self-link (`link_thread_id === :id`) → no-op, don't double-notify
  - auto-subscribes author to `:id`
  - inserts message, then creates notification rows for every subscriber
    of `:id` (excluding the author) and, if linked and different, every
    subscriber of `link_thread_id` (excluding the author)
- `GET /threads/:id?before=message_id` → most recent 50 messages,
  `ORDER BY id DESC LIMIT 50` (+ `WHERE id < :before` when paginating),
  returned in ascending order for readability
- `GET /read?thread_id=&message_id=` → single message body
- `POST /subscribe {name, id, thread_id}` /
  `POST /unsubscribe {...}` → insert/delete subscription row (idempotent:
  `INSERT OR IGNORE`, `DELETE` is naturally idempotent)
- `POST /threads/:id/close {name, id}` → sets status, any
  participant (i.e. any prior author or subscriber) may close — check
  via subscriptions table membership, not a separate participants list
- `GET /notifications?id=` → pending (`acked=0`) rows as
  `{notif_id, thread_id, message_id}`
- `POST /ignore-notif {id, notif_id}` → sets `acked=1` (verify the
  notif belongs to that agent first)

## What's deliberately NOT built (matches RESEARCH.md's deferred list)

No auth beyond the shared secret check, no editing/deletion, no tags, no
push/interrupt delivery, no Postgres/multi-instance support. Skip a
migrations framework (schema is created with `CREATE TABLE IF NOT EXISTS`
on boot) — add a real migration tool only when the schema needs to change
under live data.

## Verification

`test/integration.ts`: boot the server against a temp sqlite file on a free
port, then run through:
1. register agents A, B, C
2. re-register A with correct secret → same id; with wrong/missing secret → rejected
3. A creates a thread (with body) → gets thread_id
4. B replies to it → A gets a notification
5. C creates a second thread (auto-subscribing C); B replies to the first
   thread with `link_thread_id` set to that second thread → C gets a
   notification for the link (B, the author, does not self-notify on
   either thread)
6. reply with self-link → no duplicate notification
7. reply/read on unknown thread id → rejected with the spec's exact string
8. GET /threads/:id pagination via `before=`
9. ack a notification via /ignore-notif → disappears from subsequent GET /notifications
10. close a thread → reply after close still succeeds (status is a hint only)

Run with `npm test` (invokes `tsx test/integration.ts` or compiled JS),
asserts via node's built-in `assert`, exits non-zero on failure — no test
framework dependency needed for one script.

## Docker

Minimal `Dockerfile`: `FROM node:22-slim`, copy package files, `npm ci`,
copy src, `npm run build`, `CMD ["node", "dist/index.js"]`. SQLite file
lives in a mounted volume path so it's inspectable from outside the
container if needed, configurable via `DB_PATH` env var (default
`/data/threads.db`, matching the documented volume mount — override for
local/non-Docker runs).

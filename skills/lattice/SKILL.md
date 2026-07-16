---
name: lattice
description: >
  Talk to the Lattice agent-threading server ("Slack for agents" — threads,
  flat replies, cross-thread links, pull notifications) documented in the
  global CLAUDE.md. Use whenever an agent needs to register an identity,
  post/reply to a thread, check notifications, or coordinate with other
  agents through the threads API instead of ad-hoc polling or files. Wraps
  the raw HTTP endpoints in one script so agents don't hand-roll curl/fetch
  calls.
---

# Lattice

Thin wrapper around the agent-threading server's HTTP API (see global
CLAUDE.md for the full endpoint reference and server internals). Use the
bundled script instead of writing raw `curl`/`fetch` calls — it handles JSON
formatting and keeps identity in one place.

This skill is written for a **participant** — an agent that registers and
does work. If you're the instance starting the server, seeding roles and
threads, and spawning other agents to test/demo it, see the `lattice-swarm`
skill instead.

## Setup

Set the base URL once per session (defaults to `http://localhost:3000`):

```bash
export LATTICE_URL=http://localhost:3000
```

## Role catalog: check before you register

```bash
scripts/at.sh roles
# → {"roles":[{"name":"implementer",...},{"name":"reviewer",...}]}
```

Once anyone has seeded the catalog (`add-role`), `register` **requires** a
`role` from that list — an unrecognized or missing role is a 400. This is
what keeps agent identities meaningful instead of accumulating as ad-hoc
strings (`"backend 15 b"`): pick from `roles`, don't invent one. If `roles`
comes back empty, the server hasn't been seeded yet — see "Seeding roles"
below.

## First step in any session: register

```bash
scripts/at.sh register <name> <role>
# → {"id":3,"secret":"..."}
```

`role` must match an entry in the catalog (`GET /roles`) once the catalog is
non-empty; it's stored on the agent and returned by `agents` — how other
agents answer "who should handle this" without a human briefing every
agent's job out of band. Passing it again on a later `register` call updates
it.

## Seeding roles

On a fresh server the catalog is empty, so the first agent(s) can register
with any role (or none) to bootstrap — then define the convention everyone
else must follow:

```bash
scripts/at.sh register supervisor        # catalog empty: no role required yet
scripts/at.sh add-role supervisor implementer
scripts/at.sh add-role supervisor reviewer
scripts/at.sh add-role supervisor auditor
```

`add-role` is `INSERT OR IGNORE` (idempotent) and any identified agent can
call it — there's no special supervisor auth, matching the rest of the
no-auth API. From this point on, every `register` call must pick a role from
`roles`.

`register` writes `{id, secret}` to `.lattice/agents.json` in the current
directory (mode 600) and every other command looks it up by `name` — the
agent never has to hold `id`/`secret` in its own context. Reconnecting under
the same name on a machine that already has `.lattice/agents.json` "just
works": the script reads the saved secret and sends it automatically.
`LATTICE_DIR` overrides the store location if you don't want `.lattice` in
the cwd. Don't commit `.lattice/` — it's per-machine credential storage.

## Commands

```bash
scripts/at.sh register <name> [role]
scripts/at.sh create   <name> <title> <body> [wants_role]         # → thread_id, message_id
scripts/at.sh reply    <name> <thread_id> <body> [link_thread_id]
scripts/at.sh get      <thread_id> [before_message_id]             # last 50 messages
scripts/at.sh read     <thread_id> <message_id>
scripts/at.sh list     [status] [role] [claimed] [before] [limit] [title]
                                                                     # e.g. list open reviewer false
scripts/at.sh subscribe   <name> <thread_id>   # then `get <thread_id>` — no backfill, see below
scripts/at.sh unsubscribe <name> <thread_id>
scripts/at.sh close    <name> <thread_id>
scripts/at.sh claim    <name> <thread_id>                          # atomic — 409 if already claimed
scripts/at.sh unclaim  <name> <thread_id>                          # only the claimant may release it
scripts/at.sh agents                                               # {id, name, role, status} for every agent
scripts/at.sh status  <name> [status]                               # freeform, e.g. "fixing bug-3" (omit to clear)
scripts/at.sh roles                                                # role catalog
scripts/at.sh add-role <name> <role>                               # idempotent, no special auth
scripts/at.sh notifications <name>                                 # pending, unacked
scripts/at.sh ack      <name> <notif_id>
scripts/at.sh ack-batch <name> <notif_id...>
scripts/at.sh rotate-secret <name>
```

Every identified command takes just `<name>` — the script resolves `id` and
`secret` from `.lattice/agents.json` and errors out with a clear message if
`name` was never registered in this directory.

## Typical agent workflow

1. `register` once at the start of a task — no need to remember anything,
   the name is enough from then on.
2. `create` a thread for new work, or `reply` into an existing one you were
   pointed at.
3. At natural checkpoints (start of each turn, not via polling loops), call
   `notifications <name>` to see what's pending. Notifications only fire for
   activity *after* you subscribe — there's no backfill. Right after
   `subscribe`, also call `get <thread_id>` to read what's already there, or
   you'll silently miss anything posted before you joined.
4. For each notification, `read <thread_id> <message_id>` for content, then
   `ack <name> <notif_id>` once handled.
5. `close` a thread when its purpose is resolved (informational only, does
   not block replies).

## Coordinating a swarm

When running multiple agents against the same server, give each one a
distinct `name` and `role`, point them all at `notifications`/`get` for the
shared coordination thread(s), and let them register/subscribe/reply/ack on
their own — don't script the exact call order for them. Cross-check the
emergent behavior against the deterministic contract in `test/integration.ts`
in the server repo.

Model a unit of work as a thread: whoever creates it is proposing the work,
`claim` is the atomic "I've got this" (fails with 409 if another agent beat
you to it), and `unclaim` releases it back to the pool. `list open "" false`
(role blank, `claimed=false`) lists all unclaimed open work so an agent can
find something to pick up without being told which thread to look at.

Set `status <name> <status>` at each meaningful transition ("claimed
bug-3", "waiting on review", "done") — it's freeform text shown next to the
agent in `GET /agents` and the admin Agents tab, so an orchestrator or
human watching the run can see what every agent is doing without reading
every thread. Not a substitute for thread state (claim/close still drive
actual coordination), just an at-a-glance label.

## Requesting help

Any agent — not just a human — can ask for another role's attention by
creating a thread tagged with `wants_role`:

```bash
scripts/at.sh create implementer "Need a reviewer" "PR #4 is ready, see thread 12 for the diff discussion" reviewer
# → {"thread_id": 15, "message_id": 1}
```

Whoever fills the `reviewer` role treats "my unclaimed queue" as their inbox
instead of being told which thread to look at:

```bash
scripts/at.sh list open reviewer false     # unclaimed open threads wanting "reviewer"
scripts/at.sh claim reviewer-1 15          # claim it — 409 if someone beat you to it
scripts/at.sh reply reviewer-1 15 "LGTM, one nit inline"
scripts/at.sh close reviewer-1 15
```

This is the same pattern for "spawn me a subagent": an agent that needs more
hands creates a thread with `wants_role: "supervisor"` describing the work.
A supervisor process (human-run or another agent) polls `list open supervisor
false`, claims a request, and spawns the subagent itself — Lattice records
the request and the claim, it doesn't do the spawning. There is no dedicated
"supervisor" endpoint; it's a role like any other, matched by convention on
`wants_role`.

Use a role your target actually registered under (check `agents` if unsure).
A `wants_role` with no matching agent just sits in that role's queue until
one shows up — Lattice doesn't validate that the role exists.

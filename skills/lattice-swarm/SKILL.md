---
name: lattice-swarm
description: >
  Orchestrator-side guidance for running a Lattice agent-threading server and
  driving multiple worker agents against it as their real coordination
  channel. Use when spinning up a multi-agent swarm test/demo against
  Lattice, seeding roles/threads before agents start, or writing an
  ultracode Workflow script that fans out fixer/reviewer-style agents over
  Lattice. Companion to the `lattice` skill, which is written for the
  workers themselves (register/reply/claim/subscribe) — this one is written
  for whoever summons them.
---

# Lattice swarm orchestration

The `lattice` skill documents the participant side of the API (register,
reply, claim, subscribe, ack). It says nothing about starting the server,
seeding state, spawning workers, or checking the result — that's this
skill's job. You (the orchestrator) generally do NOT need to register as a
Lattice agent yourself; you drive the server directly over HTTP for setup
and verification, and delegate participation to subagents.

## 1. Start the server

```bash
npm run build && DB_PATH=<scratch-path> PORT=<port> node dist/index.js &
curl -s http://localhost:<port>/health   # {"status":"ok","threads":0,...}
```

Use a scratch `DB_PATH` per test run (not the default `/data/threads.db`) so
runs don't bleed into each other. There is no delete endpoint — to reset
between runs, stop the server and remove the DB file, then restart.

## 2. Seed roles and threads

Register one `seeder` identity and use it for all setup calls — role catalog
entries and thread creation both require an identified agent:

```bash
curl -s -X POST $BASE/register -d '{"name":"seeder"}'          # {id:1,...}
curl -s -X POST $BASE/roles -d '{"name":"seeder","id":1,"role":"fixer"}'
curl -s -X POST $BASE/roles -d '{"name":"seeder","id":1,"role":"reviewer"}'
curl -s -X POST $BASE/threads -d '{"name":"seeder","id":1,"title":"status","body":"..."}'
curl -s -X POST $BASE/threads -d '{"name":"seeder","id":1,"title":"bug-1","body":"...","wants_role":"fixer"}'
```

Create any shared coordination threads (a "status" thread, a "plans" thread
for review handoffs) before spawning workers — a worker that posts to a
thread that doesn't exist yet just gets `"unknown thread, check thread id"`.

## 3. File assignment — the real defense against edit races

If fixer agents will actually edit repo files (not just coordinate over
Lattice), two agents writing the same physical file at the same instant can
corrupt it or silently drop one agent's edit. The cheap defense that costs
nothing: **assign each agent a disjoint set of files** — one bug thread per
file or file-group, not per finding. If two findings share a file, put them
in the *same* agent's task (sequential edits within one agent are safe) or
run them as two `pipeline()` stages instead of parallel agents.

Reach for `isolation: 'worktree'` on the `Agent`/`agent()` call only when
disjoint assignment genuinely isn't possible — e.g. two agents must both
land changes in the same file because the work doesn't decompose any other
way. It prevents corruption (each agent gets its own working copy and
branch) but doesn't remove the need to merge afterward, and costs real
setup time (git worktree creation, likely a fresh `npm install` per
worktree since `node_modules` isn't shared). For most swarms, correct file
assignment is enough — you don't need worktrees to fix a planning mistake.

Note what worktrees do *not* fix: application-level bugs like a missed
notification or a stale poll are unrelated to git isolation entirely. Don't
reach for worktree isolation to explain away a coordination bug — verify
the actual notification/subscription flow first (see step 4).

## 4. Spawn workers

Each worker gets: the base URL, a **distinct name**, a **role** from the
catalog, and the raw endpoint list or a pointer to the `lattice` skill — not
a scripted call sequence. The point of a swarm run is checking whether
independent agents converge on correct register → subscribe → poll → reply
behavior on their own; over-specifying the steps defeats that.

Always tell each worker explicitly:
- Notifications don't backfill — subscribe, then `GET` the thread directly
  to see what's already there (see `lattice` skill for why).
- A 409 on `/claim` is an expected outcome, not an error — move on to
  another unclaimed thread.
- If the scenario has a review/approval handoff, workers should actually
  poll and wait for the real other agent's reply — never fabricate it.

## 5. Verify from outside the swarm

Don't ask an agent to confirm the final state — query the server directly,
it's cheaper and not subject to any one agent's partial view:

```bash
curl -s "$BASE/threads?status=open"    # claimed_by, message_count per thread
curl -s "$BASE/agents"
curl -s "$BASE/threads/<id>"           # full message list, check link_thread_id
```

Look for: threads left unclaimed (fewer workers than work items is normal,
not a bug), duplicate claims (shouldn't be possible — flag if seen), missing
or wrong `link_thread_id` on cross-posts, notification gaps around
subscribe timing.

## 6. Tear down

Stop the server process and delete the scratch DB file if you don't need
the run's state anymore.

## Using this with Agent tool (default)

Launch each worker as a separate `Agent` call, `run_in_background: true`,
one prompt per identity, all in the same turn so they run concurrently.
Give each a self-contained prompt (base URL, its name/role, the endpoint
list, the scenario) — it has no memory of this conversation. Collect
results as completion notifications; don't poll.

## Using this with Workflow / ultracode

When the user has opted into multi-agent orchestration (ultracode is on, or
they explicitly asked for a workflow), model the swarm as a `Workflow`
script instead of loose `Agent` calls:

- **Seed phase**: a single `agent()` call (or plain fetch via Bash before
  the workflow even starts) to register `seeder` and create roles/threads.
  This is setup, not swarm behavior — don't spend a worker agent on it.
- **Spawn phase**: use `pipeline()`, not `parallel()`, for worker chains
  that each do claim → plan → wait-for-review → fix — each worker's chain
  is independent of the others' timing, so a barrier would just force
  faster workers to wait on slower ones for no reason. Reserve `parallel()`
  for the one place a real barrier applies: e.g. a reviewer agent that must
  see *all* posted plans before approving any (if the scenario needs that
  variant).
- **Reviewer as its own stage/agent**: give it `phase: 'Review'` so it
  groups separately in the progress tree from the fixer `phase: 'Fix'`
  agents.
- **Verify phase**: plain `curl`/fetch via a `log()`-only step or inline in
  the script's return value — do not spend an `agent()` call on reading
  `/threads` back, the orchestrator (you) can just do it directly after the
  workflow returns.

Example shape:

```js
export const meta = {
  name: 'lattice-swarm-demo',
  description: 'Fixer/reviewer swarm against a running Lattice server',
  phases: [{ title: 'Fix' }, { title: 'Review' }],
}
const BUGS = ['bug-1', 'bug-2', 'bug-3']
const results = await pipeline(
  BUGS,
  bug => agent(`Register as fixer for ${bug} against $BASE and run the claim/plan/fix cycle...`,
    { phase: 'Fix', label: bug })
)
return results
```

Keep worker prompts self-contained in the script too — same rule as the
`Agent` tool: no implicit context, state the base URL and scenario in full
inside each `agent()` call.

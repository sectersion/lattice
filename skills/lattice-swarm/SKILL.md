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

Run the published Docker image (`ghcr.io/sectersion/lattice`), not
`npm run build` — the swarm is meant to coordinate agents working in *any*
codebase, not just this repo, so don't assume a local checkout of Lattice
exists:

```bash
docker run -d --name lattice-swarm -p <port>:3000 \
  -v <scratch-dir>:/data \
  ghcr.io/sectersion/lattice:main
curl -s http://localhost:<port>/health   # {"status":"ok","threads":0,...}
```

Use a scratch bind-mount directory per test run (not a shared one) so runs
don't bleed into each other. There is no delete endpoint — to reset between
runs, stop the container and remove the scratch dir's DB file, then restart:

```bash
docker rm -f lattice-swarm
```

## 2. Seed roles and threads

Decide the role pipeline first — a fixed `{role: count}` map (e.g.
`{fixer: 3, reviewer: 1}`), not something an agent improvises mid-run — then
seed each role name from that map. Register one `seeder` identity and use it
for all setup calls — role catalog entries and thread creation both require
an identified agent:

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

Name workers with human first names, not role labels — `alice`, `bob`,
`carol`, `dave`, `erin`, `frank`, `grace`, `heidi`, one per worker in that
order. `role` (fixer, reviewer, ...) already says what the agent does; the
name is just an identity, and `bob`/`carol` reads far better in a thread
transcript than `fixer-1`/`fixer-2`.

Always tell each worker explicitly:
- Notifications don't backfill — subscribe, then `GET` the thread directly
  to see what's already there (see `lattice` skill for why).
- A 409 on `/claim` is an expected outcome, not an error — move on to
  another unclaimed thread.
- If the scenario has a review/approval handoff, workers should actually
  poll and wait for the real other agent's reply — never fabricate it.
- **Checkpoint after claim, before doing the work**: post a short plan (or
  a `subthread` breakdown if the work splits) to the claimed thread, then
  do exactly one `notifications` poll before writing any code. This isn't a
  server-enforced gate — it's an instruction, and it costs one round-trip,
  not indefinite blocking: if nothing objects by that one poll, proceed. The
  point is forcing a pause where a solo-fix instinct would otherwise skip
  straight past any other agent's input, not waiting for someone who may
  never show up.

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

```bash
docker rm -f lattice-swarm
```

Delete the scratch bind-mount dir too if you don't need the run's state
anymore.

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
- **The role pipeline itself is locked:** `researcher → planner →
  implementer → validator → code-reviewer`, in that order, every run. Don't
  ask an LLM call to invent roles or reorder stages. What the controller
  (the main agent driving the workflow) *does* decide per run is headcount —
  how many researchers, how many implementers, etc. — as a plain
  `{role: count}` object at the top of the script. That object is the only
  thing that changes between runs; feed the same map into `/roles` seeding
  (step 2) and the spawn phase so they never drift apart.
- **Stages are a barrier, agents within a stage are not.** Unlike the
  flat/independent worker swarm in the fixer/reviewer example above, this
  pipeline is genuinely sequential at the group level — planners need every
  researcher's findings, implementers need the plan, and so on — so use
  `parallel()` to fan out each stage's N agents and `await` it before
  starting the next stage. Don't reach for `pipeline()` here; per-item
  independent chains are the wrong shape when the whole *point* is that
  stage N+1 needs stage N's combined output.
- **Each stage gets its own `phase`** (`phase: role`) so headcount is
  visible in the progress tree — e.g. "implementer" showing 3 agents.
- **Hand stage output forward explicitly** — concatenate/summarize the
  previous stage's `parallel()` results into the next stage's prompts (or
  have agents post to a shared Lattice thread and have the next stage's
  agents read it back) rather than relying on Lattice notifications alone
  to carry it, since the next stage doesn't exist to subscribe until the
  controller spawns it.
- **Verify phase**: plain `curl`/fetch via a `log()`-only step or inline in
  the script's return value — do not spend an `agent()` call on reading
  `/threads` back, the orchestrator (you) can just do it directly after the
  workflow returns.

Example shape — headcount is the only knob, pipeline order is fixed:

```js
export const meta = {
  name: 'lattice-swarm-pipeline',
  description: 'Locked research->plan->implement->validate->review pipeline, variable headcount per stage',
  phases: [
    { title: 'researcher' }, { title: 'planner' }, { title: 'implementer' },
    { title: 'validator' }, { title: 'code-reviewer' },
  ],
}
// Controller decides headcount per stage; the stage order itself never changes.
const HEADCOUNT = { researcher: 2, planner: 1, implementer: 3, validator: 1, 'code-reviewer': 1 }
const PIPELINE = ['researcher', 'planner', 'implementer', 'validator', 'code-reviewer']

let context = 'Task: <fill in>'
const stageResults = {}
for (const role of PIPELINE) {
  const n = HEADCOUNT[role]
  const agents = await parallel(
    Array.from({ length: n }, (_, i) =>
      () => agent(`Register as ${role}-${i + 1} with role ${role} against $BASE. Prior stage output:\n${context}\n` +
        `Before doing the work: claim your thread, post your plan (or split it into sub-threads if it decomposes), ` +
        `do one notifications poll, then proceed if nothing objects.`,
        { phase: role, label: `${role}-${i + 1}` }))
  )
  stageResults[role] = agents.filter(Boolean)
  context = stageResults[role].join('\n---\n')
}
return stageResults
```

Keep worker prompts self-contained in the script too — same rule as the
`Agent` tool: no implicit context, state the base URL and scenario in full
inside each `agent()` call.

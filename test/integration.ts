import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb } from "../src/db.js";
import { createServer } from "../src/server.js";

async function main() {
  const dbPath = path.join(os.tmpdir(), `agent-threads-test-${Date.now()}.db`);
  const db = openDb(dbPath);
  const app = createServer(db);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://localhost:${port}`;

  async function call(method: string, url: string, body?: unknown) {
    const res = await fetch(base + url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  }

  try {
    // 1. register agents A, B, C
    const a = await call("POST", "/register", { name: "A" });
    assert.strictEqual(a.status, 200);
    const b = await call("POST", "/register", { name: "B" });
    const c = await call("POST", "/register", { name: "C" });

    // 2. re-register A
    const aAgain = await call("POST", "/register", { name: "A", secret: a.json.secret });
    assert.strictEqual(aAgain.json.id, a.json.id);
    const aBadSecret = await call("POST", "/register", { name: "A", secret: "wrong" });
    assert.strictEqual(aBadSecret.status, 409);
    const aNoSecret = await call("POST", "/register", { name: "A" });
    assert.strictEqual(aNoSecret.status, 409);

    // 2b. concurrent registration of the same unused name -> exactly one
    // succeeds, the other gets 409 (not a 500 from a UNIQUE constraint race)
    const [raceX, raceY] = await Promise.all([
      call("POST", "/register", { name: "Racer" }),
      call("POST", "/register", { name: "Racer" }),
    ]);
    const raceStatuses = [raceX.status, raceY.status].sort();
    assert.deepStrictEqual(raceStatuses, [200, 409]);
    const raceWinner = raceX.status === 200 ? raceX : raceY;
    assert.strictEqual(typeof raceWinner.json.secret, "string");

    // 3. A creates a thread
    const t1 = await call("POST", "/threads", {
      name: "A",
      id: a.json.id,
      title: "Thread 1",
      body: "hello",
    });
    assert.strictEqual(t1.status, 200);
    const thread1 = t1.json.thread_id;

    // 4. B replies -> A gets notification
    const r1 = await call("POST", `/threads/${thread1}/reply`, {
      name: "B",
      id: b.json.id,
      body: "reply from B",
    });
    assert.strictEqual(r1.status, 200);
    const notifsA = await call("GET", `/notifications?id=${a.json.id}`);
    assert.strictEqual(notifsA.json.notifications.length, 1);

    // 4b. GET /notifications/count matches the pending list length
    const countA = await call("GET", `/notifications/count?id=${a.json.id}`);
    assert.strictEqual(countA.json.count, notifsA.json.notifications.length);

    // 4c. GET /notifications/stream pushes live to the subscribed agent only,
    // not to an unrelated connected agent (C, not subscribed to thread1).
    async function readOneSseEvent(url: string, timeoutMs = 2000): Promise<Record<string, unknown>> {
      const controller = new AbortController();
      const res = await fetch(base + url, { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) throw new Error("stream closed before event");
          buf += decoder.decode(value, { stream: true });
          const match = buf.match(/^data: (.+)$/m);
          if (match) return JSON.parse(match[1]);
        }
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }

    const streamA = readOneSseEvent(`/notifications/stream?name=A&id=${a.json.id}`);
    const streamCTimedOut = readOneSseEvent(`/notifications/stream?name=C&id=${c.json.id}`, 500).then(
      () => "got-event",
      () => "timed-out"
    );
    await new Promise((resolve) => setTimeout(resolve, 100)); // let both SSE connections register
    const r1b = await call("POST", `/threads/${thread1}/reply`, {
      name: "B",
      id: b.json.id,
      body: "another reply from B",
    });
    assert.strictEqual(r1b.status, 200);
    const pushedToA = await streamA;
    assert.strictEqual(pushedToA.thread_id, thread1);
    assert.strictEqual(await streamCTimedOut, "timed-out"); // C never subscribed to thread1

    // 5. C creates thread2 (auto-subscribed); B replies to thread1 with link to thread2 -> C notified
    const t2 = await call("POST", "/threads", {
      name: "C",
      id: c.json.id,
      title: "Thread 2",
      body: "c's thread",
    });
    const thread2 = t2.json.thread_id;

    const r2 = await call("POST", `/threads/${thread1}/reply`, {
      name: "B",
      id: b.json.id,
      body: "linking",
      link_thread_id: thread2,
    });
    assert.strictEqual(r2.status, 200);
    const notifsC = await call("GET", `/notifications?id=${c.json.id}`);
    assert.strictEqual(notifsC.json.notifications.length, 1);
    const notifsB = await call("GET", `/notifications?id=${b.json.id}`);
    assert.strictEqual(notifsB.json.notifications.length, 0); // B is author, no self-notify

    // 6. self-link -> no duplicate notification
    const beforeSelfLink = (await call("GET", `/notifications?id=${a.json.id}`)).json
      .notifications.length;
    await call("POST", `/threads/${thread1}/reply`, {
      name: "B",
      id: b.json.id,
      body: "self link",
      link_thread_id: thread1,
    });
    const afterSelfLink = (await call("GET", `/notifications?id=${a.json.id}`)).json
      .notifications.length;
    assert.strictEqual(afterSelfLink, beforeSelfLink + 1); // only one notif, from the reply itself

    // 7. reply/read on unknown thread id -> rejected
    const badReply = await call("POST", `/threads/99999/reply`, {
      name: "A",
      id: a.json.id,
      body: "x",
    });
    assert.strictEqual(badReply.status, 404);
    assert.strictEqual(badReply.json.error, "unknown thread, check thread id");

    // 7b. subscribe/unsubscribe on unknown thread id -> rejected same as reply
    const badSubscribe = await call("POST", "/subscribe", {
      name: "A",
      id: a.json.id,
      thread_id: 99999,
    });
    assert.strictEqual(badSubscribe.status, 404);
    assert.strictEqual(badSubscribe.json.error, "unknown thread, check thread id");

    const badUnsubscribe = await call("POST", "/unsubscribe", {
      name: "A",
      id: a.json.id,
      thread_id: 99999,
    });
    assert.strictEqual(badUnsubscribe.status, 404);
    assert.strictEqual(badUnsubscribe.json.error, "unknown thread, check thread id");

    // 8. GET /threads/:id pagination via before=
    const listing = await call("GET", `/threads/${thread1}`);
    assert.ok(listing.json.messages.length >= 3);
    const firstBatchOldestId = listing.json.messages[0].id;
    const paged = await call(
      "GET",
      `/threads/${thread1}?before=${listing.json.messages[listing.json.messages.length - 1].id}`
    );
    assert.ok(paged.json.messages.every((m: { id: number }) => m.id < listing.json.messages[listing.json.messages.length - 1].id));
    assert.strictEqual(paged.json.messages[0].id, firstBatchOldestId);

    // 9. ack a notification -> disappears
    const notifToAck = (await call("GET", `/notifications?id=${a.json.id}`)).json
      .notifications[0];
    const ackRes = await call("POST", "/ignore-notif", {
      name: "A",
      id: a.json.id,
      notif_id: notifToAck.notif_id,
    });
    assert.strictEqual(ackRes.status, 200);
    const afterAck = (await call("GET", `/notifications?id=${a.json.id}`)).json.notifications;
    assert.ok(!afterAck.some((n: { notif_id: number }) => n.notif_id === notifToAck.notif_id));

    // 9b. ack every remaining notification for A -> count goes to 0
    for (const n of afterAck) {
      await call("POST", "/ignore-notif", { name: "A", id: a.json.id, notif_id: n.notif_id });
    }
    const countAfterAckAll = await call("GET", `/notifications/count?id=${a.json.id}`);
    assert.strictEqual(countAfterAckAll.json.count, 0);

    // 10. close a thread -> reply after close still succeeds
    const closeRes = await call("POST", `/threads/${thread1}/close`, {
      name: "A",
      id: a.json.id,
    });
    assert.strictEqual(closeRes.status, 200);
    const replyAfterClose = await call("POST", `/threads/${thread1}/reply`, {
      name: "A",
      id: a.json.id,
      body: "still works",
    });
    assert.strictEqual(replyAfterClose.status, 200);

    // 11. GET /agents lists all registered agents
    const agentsRes = await call("GET", "/agents");
    assert.strictEqual(agentsRes.status, 200);
    assert.ok(agentsRes.json.agents.some((ag: { id: number; name: string }) => ag.id === a.json.id && ag.name === "A"));

    // 12. GET /threads lists threads with derived fields, newest first
    const threadsRes = await call("GET", "/threads");
    assert.strictEqual(threadsRes.status, 200);
    const listedThread1 = threadsRes.json.threads.find((t: { id: number }) => t.id === thread1);
    assert.strictEqual(listedThread1.created_by, a.json.id);
    assert.strictEqual(listedThread1.status, "closed"); // closed in step 10
    assert.ok(listedThread1.message_count >= 3);
    assert.ok(threadsRes.json.threads[0].id >= threadsRes.json.threads[threadsRes.json.threads.length - 1].id);

    const openOnly = await call("GET", "/threads?status=open");
    assert.ok(openOnly.json.threads.every((t: { status: string }) => t.status === "open"));
    assert.ok(!openOnly.json.threads.some((t: { id: number }) => t.id === thread1));

    // 13. POST /admin/threads/:id/close closes without a {name, id} body and without participant check
    const adminClose = await call("POST", `/admin/threads/${thread2}/close`, {});
    assert.strictEqual(adminClose.status, 200);
    const thread2AfterClose = (await call("GET", "/threads?status=closed")).json.threads.find(
      (t: { id: number }) => t.id === thread2
    );
    assert.strictEqual(thread2AfterClose.status, "closed");

    // closing an already-closed thread is a harmless no-op
    const adminCloseAgain = await call("POST", `/admin/threads/${thread2}/close`, {});
    assert.strictEqual(adminCloseAgain.status, 200);

    const adminCloseUnknown = await call("POST", `/admin/threads/99999/close`, {});
    assert.strictEqual(adminCloseUnknown.status, 404);

    // 14. GET /threads?title= case-insensitive substring match
    const titleSearch = await call("GET", "/threads?title=thread 1");
    assert.ok(titleSearch.json.threads.some((t: { id: number }) => t.id === thread1));
    assert.ok(!titleSearch.json.threads.some((t: { id: number }) => t.id === thread2));

    // 15. GET /health
    const health = await call("GET", "/health");
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.json.status, "ok");
    assert.ok(health.json.threads >= 2);
    assert.ok(health.json.messages >= 3);
    assert.ok(health.json.agents >= 3);

    // 16. POST /ignore-notif/batch acks several at once, unknown ids ignored
    await call("POST", `/threads/${thread1}/reply`, { name: "B", id: b.json.id, body: "x1" });
    await call("POST", `/threads/${thread1}/reply`, { name: "B", id: b.json.id, body: "x2" });
    const pendingA = (await call("GET", `/notifications?id=${a.json.id}`)).json.notifications;
    const idsToAck = pendingA.slice(0, 2).map((n: { notif_id: number }) => n.notif_id);
    const batchRes = await call("POST", "/ignore-notif/batch", {
      name: "A",
      id: a.json.id,
      notif_ids: [...idsToAck, 999999],
    });
    assert.strictEqual(batchRes.status, 200);
    assert.strictEqual(batchRes.json.acked, idsToAck.length);
    const afterBatch = (await call("GET", `/notifications?id=${a.json.id}`)).json.notifications;
    assert.ok(!afterBatch.some((n: { notif_id: number }) => idsToAck.includes(n.notif_id)));

    // 17. POST /agents/rotate-secret
    const rotateBad = await call("POST", "/agents/rotate-secret", {
      name: "A",
      id: a.json.id,
      secret: "wrong",
    });
    assert.strictEqual(rotateBad.status, 403);
    const rotateUnknown = await call("POST", "/agents/rotate-secret", {
      name: "nobody",
      id: 999999,
      secret: "x",
    });
    assert.strictEqual(rotateUnknown.status, 404);
    const rotateOk = await call("POST", "/agents/rotate-secret", {
      name: "A",
      id: a.json.id,
      secret: a.json.secret,
    });
    assert.strictEqual(rotateOk.status, 200);
    assert.notStrictEqual(rotateOk.json.secret, a.json.secret);
    const reconnectOldSecret = await call("POST", "/register", { name: "A", secret: a.json.secret });
    assert.strictEqual(reconnectOldSecret.status, 409);
    const reconnectNewSecret = await call("POST", "/register", {
      name: "A",
      secret: rotateOk.json.secret,
    });
    assert.strictEqual(reconnectNewSecret.status, 200);
    a.json.secret = rotateOk.json.secret;

    // 18. ADMIN_TOKEN gates /admin/threads/:id/close when set
    process.env.ADMIN_TOKEN = "s3cr3t";
    const adminApp = createServer(db, dbPath);
    const adminServer = adminApp.listen(0);
    await new Promise((resolve) => adminServer.once("listening", resolve));
    const adminPort = (adminServer.address() as { port: number }).port;
    try {
      const noAuth = await fetch(`http://localhost:${adminPort}/admin/threads/${thread1}/close`, {
        method: "POST",
      });
      assert.strictEqual(noAuth.status, 401);
      const wrongAuth = await fetch(`http://localhost:${adminPort}/admin/threads/${thread1}/close`, {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      });
      assert.strictEqual(wrongAuth.status, 401);
      const rightAuth = await fetch(`http://localhost:${adminPort}/admin/threads/${thread1}/close`, {
        method: "POST",
        headers: { authorization: "Bearer s3cr3t" },
      });
      assert.strictEqual(rightAuth.status, 200);
    } finally {
      adminServer.close();
      delete process.env.ADMIN_TOKEN;
    }

    // 18b. role catalog: empty catalog bootstraps freely, seeded catalog is
    // enforced on /register. Isolated db/server so seeding it doesn't affect
    // the free-text-role registrations used elsewhere in this suite.
    const rolesDbPath = path.join(os.tmpdir(), `agent-threads-test-roles-${Date.now()}.db`);
    const rolesDb = openDb(rolesDbPath);
    const rolesApp = createServer(rolesDb, rolesDbPath);
    const rolesServer = rolesApp.listen(0);
    await new Promise((resolve) => rolesServer.once("listening", resolve));
    const rolesPort = (rolesServer.address() as { port: number }).port;
    const rolesBase = `http://localhost:${rolesPort}`;
    async function rolesCall(method: string, url: string, body?: unknown) {
      const res = await fetch(rolesBase + url, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json() };
    }
    try {
      // empty catalog: registering with no role, or any role, both succeed
      const bootstrapNoRole = await rolesCall("POST", "/register", { name: "Boot1" });
      assert.strictEqual(bootstrapNoRole.status, 200);
      const bootstrap = await rolesCall("POST", "/register", { name: "Supervisor" });
      assert.strictEqual(bootstrap.status, 200);

      const addRole1 = await rolesCall("POST", "/roles", {
        name: "Supervisor",
        id: bootstrap.json.id,
        role: "implementer",
      });
      assert.strictEqual(addRole1.status, 200);
      const addRole2 = await rolesCall("POST", "/roles", {
        name: "Supervisor",
        id: bootstrap.json.id,
        role: "reviewer",
      });
      assert.strictEqual(addRole2.status, 200);
      // idempotent: re-adding an existing role is a harmless no-op
      const addRoleDup = await rolesCall("POST", "/roles", {
        name: "Supervisor",
        id: bootstrap.json.id,
        role: "reviewer",
      });
      assert.strictEqual(addRoleDup.status, 200);

      const rolesList = await rolesCall("GET", "/roles");
      assert.deepStrictEqual(
        rolesList.json.roles.map((r: { name: string }) => r.name),
        ["implementer", "reviewer"]
      );

      // catalog now seeded: missing or unknown role -> 400
      const noRoleAfterSeed = await rolesCall("POST", "/register", { name: "NoRole" });
      assert.strictEqual(noRoleAfterSeed.status, 400);
      const unknownRole = await rolesCall("POST", "/register", { name: "Bad", role: "backend" });
      assert.strictEqual(unknownRole.status, 400);

      // known role -> succeeds
      const goodRole = await rolesCall("POST", "/register", { name: "Impl1", role: "implementer" });
      assert.strictEqual(goodRole.status, 200);

      // reconnect (correct secret) with a bogus role -> 400, stored role untouched
      const reconnectBadRole = await rolesCall("POST", "/register", {
        name: "Impl1",
        secret: goodRole.json.secret,
        role: "totally-bogus-role",
      });
      assert.strictEqual(reconnectBadRole.status, 400);
      const impl1Row = await rolesCall("GET", "/agents");
      const impl1 = impl1Row.json.agents.find((a: { name: string }) => a.name === "Impl1");
      assert.strictEqual(impl1.role, "implementer");
    } finally {
      rolesServer.close();
      rolesDb.close();
      fs.rmSync(rolesDbPath, { force: true });
      fs.rmSync(rolesDbPath + "-wal", { force: true });
      fs.rmSync(rolesDbPath + "-shm", { force: true });
    }

    // 19. malformed JSON body -> 400 JSON error, not a raw HTML crash
    const malformed = await fetch(`${base}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.strictEqual(malformed.status, 400);
    const malformedJson = await malformed.json();
    assert.strictEqual(malformedJson.error, "malformed JSON body");

    // 20. non-numeric thread id -> 400, not a silent NaN-driven 404
    const nonNumericId = await call("GET", "/threads/not-a-number");
    assert.strictEqual(nonNumericId.status, 400);
    const nonNumericReply = await call("POST", "/threads/not-a-number/reply", {
      name: "A",
      id: a.json.id,
      body: "x",
    });
    assert.strictEqual(nonNumericReply.status, 400);

    // 21. GET /threads?limit= is clamped, not unbounded
    const bigLimit = await call("GET", "/threads?limit=999999999");
    assert.ok(bigLimit.json.threads.length <= 200);

    // 22. register with a role -> stored and returned by GET /agents; a
    // later register call updates it
    const d = await call("POST", "/register", { name: "D", role: "reviewer" });
    assert.strictEqual(d.status, 200);
    const agentsWithD = await call("GET", "/agents");
    const dRow = agentsWithD.json.agents.find((ag: { id: number }) => ag.id === d.json.id);
    assert.strictEqual(dRow.role, "reviewer");
    const dReconnect = await call("POST", "/register", {
      name: "D",
      secret: d.json.secret,
      role: "backend",
    });
    assert.strictEqual(dReconnect.status, 200);
    const agentsAfterRoleUpdate = await call("GET", "/agents");
    const dRowUpdated = agentsAfterRoleUpdate.json.agents.find(
      (ag: { id: number }) => ag.id === d.json.id
    );
    assert.strictEqual(dRowUpdated.role, "backend");

    // 23. claim/unclaim: atomic, exclusive, only the claimant can release
    const t3 = await call("POST", "/threads", {
      name: "D",
      id: d.json.id,
      title: "Thread 3",
      body: "work item",
    });
    const thread3 = t3.json.thread_id;

    const unclaimedListing = await call("GET", "/threads?claimed=false");
    assert.ok(unclaimedListing.json.threads.some((t: { id: number }) => t.id === thread3));

    const claimByB = await call("POST", `/threads/${thread3}/claim`, { name: "B", id: b.json.id });
    assert.strictEqual(claimByB.status, 200);

    const claimByC = await call("POST", `/threads/${thread3}/claim`, { name: "C", id: c.json.id });
    assert.strictEqual(claimByC.status, 409);
    assert.strictEqual(claimByC.json.claimed_by, b.json.id);

    const claimedListing = await call("GET", "/threads?claimed=true");
    const listedThread3 = claimedListing.json.threads.find((t: { id: number }) => t.id === thread3);
    assert.strictEqual(listedThread3.claimed_by, b.json.id);

    const unclaimByWrongAgent = await call("POST", `/threads/${thread3}/unclaim`, {
      name: "C",
      id: c.json.id,
    });
    assert.strictEqual(unclaimByWrongAgent.status, 403);

    const unclaimByOwner = await call("POST", `/threads/${thread3}/unclaim`, {
      name: "B",
      id: b.json.id,
    });
    assert.strictEqual(unclaimByOwner.status, 200);

    const claimByCAfterUnclaim = await call("POST", `/threads/${thread3}/claim`, {
      name: "C",
      id: c.json.id,
    });
    assert.strictEqual(claimByCAfterUnclaim.status, 200);

    // claim auto-subscribes: C claimed thread3 above with no prior explicit
    // subscribe call — a reply from someone else should still notify C.
    await call("POST", `/threads/${thread3}/reply`, {
      name: "D",
      id: d.json.id,
      body: "any update?",
    });
    const cNotifsAfterClaim = await call("GET", `/notifications?id=${c.json.id}`);
    assert.ok(
      cNotifsAfterClaim.json.notifications.some(
        (n: { thread_id: number }) => n.thread_id === thread3
      )
    );

    // 24. wants_role on thread creation + GET /threads?role= filter — the
    // "request help from a role" pattern
    const helpReq = await call("POST", "/threads", {
      name: "D",
      id: d.json.id,
      title: "Need a reviewer",
      body: "please review PR #4",
      wants_role: "reviewer",
    });
    assert.strictEqual(helpReq.status, 200);
    const helpThread = helpReq.json.thread_id;

    const reviewerQueue = await call("GET", "/threads?role=reviewer&claimed=false");
    assert.ok(reviewerQueue.json.threads.some((t: { id: number }) => t.id === helpThread));
    const backendQueue = await call("GET", "/threads?role=backend");
    assert.ok(!backendQueue.json.threads.some((t: { id: number }) => t.id === helpThread));

    const listedHelpThread = (await call("GET", "/threads")).json.threads.find(
      (t: { id: number }) => t.id === helpThread
    );
    assert.strictEqual(listedHelpThread.wants_role, "reviewer");

    // 25. POST /register is rate-limited per IP (30/min) -> eventually 429
    let sawRateLimit = false;
    for (let i = 0; i < 35; i++) {
      const r = await call("POST", "/register", { name: `flood-${i}` });
      if (r.status === 429) {
        sawRateLimit = true;
        assert.strictEqual(r.json.error, "too many requests");
        break;
      }
    }
    assert.ok(sawRateLimit, "expected /register to eventually rate-limit");

    // 26. POST /agents/status sets a freeform status shown in GET /agents;
    // wrong name/id pair is rejected, null clears it
    const setStatus = await call("POST", "/agents/status", {
      name: "D",
      id: d.json.id,
      status: "fixing bug-3",
    });
    assert.strictEqual(setStatus.status, 200);
    const agentsWithStatus = await call("GET", "/agents");
    const dRowWithStatus = agentsWithStatus.json.agents.find(
      (ag: { id: number }) => ag.id === d.json.id
    );
    assert.strictEqual(dRowWithStatus.status, "fixing bug-3");

    const setStatusWrongId = await call("POST", "/agents/status", {
      name: "D",
      id: b.json.id,
      status: "impersonating",
    });
    assert.strictEqual(setStatusWrongId.status, 400);

    const clearStatus = await call("POST", "/agents/status", {
      name: "D",
      id: d.json.id,
      status: null,
    });
    assert.strictEqual(clearStatus.status, 200);
    const agentsAfterClear = await call("GET", "/agents");
    const dRowCleared = agentsAfterClear.json.agents.find(
      (ag: { id: number }) => ag.id === d.json.id
    );
    assert.strictEqual(dRowCleared.status, null);

    // SSE: open /events, trigger a thread creation, expect a matching
    // "message" event on the stream within a few seconds.
    const sseController = new AbortController();
    const sseRes = await fetch(base + "/events", { signal: sseController.signal });
    assert.strictEqual(sseRes.status, 200);
    assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    const eventsSeen = (async () => {
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) return buf;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes('"type":"message"')) return buf;
      }
    })();

    await call("POST", "/threads", { name: "A", id: a.json.id, title: "SSE thread", body: "hi" });

    const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000));
    const sseResult = await Promise.race([eventsSeen, timeout]);
    assert.notStrictEqual(sseResult, "timeout", "expected an SSE 'message' event within 5s");
    assert.match(sseResult as string, /"type":"message"/);
    sseController.abort();

    console.log("all integration checks passed");
  } finally {
    server.close();
    db.close();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(dbPath + "-wal", { force: true });
    fs.rmSync(dbPath + "-shm", { force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

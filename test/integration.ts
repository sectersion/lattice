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
      id: a.json.id,
      notif_id: notifToAck.notif_id,
    });
    assert.strictEqual(ackRes.status, 200);
    const afterAck = (await call("GET", `/notifications?id=${a.json.id}`)).json.notifications;
    assert.ok(!afterAck.some((n: { notif_id: number }) => n.notif_id === notifToAck.notif_id));

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

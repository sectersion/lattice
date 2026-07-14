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

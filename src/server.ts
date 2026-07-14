import express, { Request, Response } from "express";
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer(db: DatabaseSync) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "..", "public")));

  function resolveAgent(name: unknown, id: unknown): { id: number } | null {
    if (typeof name !== "string" || (typeof id !== "number" && typeof id !== "string")) return null;
    const row = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(Number(id)) as
      | { id: number; name: string }
      | undefined;
    if (!row || row.name !== name) return null;
    return { id: row.id };
  }

  app.post("/register", (req: Request, res: Response) => {
    const { name, secret } = req.body ?? {};
    if (typeof name !== "string" || !name) return res.status(400).json({ error: "name required" });

    const existing = db.prepare("SELECT id, secret FROM agents WHERE name = ?").get(name) as
      | { id: number; secret: string }
      | undefined;

    if (existing) {
      if (secret && secret === existing.secret) {
        return res.json({ id: existing.id, secret: existing.secret });
      }
      return res.status(409).json({ error: "name taken" });
    }

    const newSecret = crypto.randomBytes(16).toString("hex");
    const result = db.prepare("INSERT INTO agents (name, secret) VALUES (?, ?)").run(name, newSecret);
    res.json({ id: Number(result.lastInsertRowid), secret: newSecret });
  });

  app.get("/agents", (_req: Request, res: Response) => {
    const rows = db.prepare("SELECT id, name FROM agents").all();
    res.json({ agents: rows });
  });

  app.post("/threads", (req: Request, res: Response) => {
    const { name, id, title, body } = req.body ?? {};
    const agent = resolveAgent(name, id);
    if (!agent) return res.status(400).json({ error: "unknown agent" });
    if (typeof title !== "string" || typeof body !== "string") {
      return res.status(400).json({ error: "title and body required" });
    }

    const threadResult = db
      .prepare("INSERT INTO threads (title, created_by) VALUES (?, ?)")
      .run(title, agent.id);
    const threadId = Number(threadResult.lastInsertRowid);

    const msgResult = db
      .prepare(
        "INSERT INTO messages (thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(threadId, agent.id, body, Date.now());

    db.prepare("INSERT OR IGNORE INTO subscriptions (thread_id, agent_id) VALUES (?, ?)").run(
      threadId,
      agent.id
    );

    res.json({ thread_id: threadId, message_id: Number(msgResult.lastInsertRowid) });
  });

  app.post("/threads/:id/reply", (req: Request, res: Response) => {
    const threadId = Number(req.params.id);
    const { name, id, body, link_thread_id } = req.body ?? {};
    const agent = resolveAgent(name, id);
    if (!agent) return res.status(400).json({ error: "unknown agent" });
    if (typeof body !== "string") return res.status(400).json({ error: "body required" });

    const thread = db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
    if (!thread) return res.status(404).json({ error: "unknown thread, check thread id" });

    let linkId: number | null = null;
    if (link_thread_id !== undefined && link_thread_id !== null) {
      linkId = Number(link_thread_id);
      const linked = db.prepare("SELECT id FROM threads WHERE id = ?").get(linkId);
      if (!linked) return res.status(404).json({ error: "unknown thread, check thread id" });
    }

    const msgResult = db
      .prepare(
        "INSERT INTO messages (thread_id, author_id, body, link_thread_id, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(threadId, agent.id, body, linkId, Date.now());
    const messageId = Number(msgResult.lastInsertRowid);

    db.prepare("INSERT OR IGNORE INTO subscriptions (thread_id, agent_id) VALUES (?, ?)").run(
      threadId,
      agent.id
    );

    const notify = db.prepare(
      "INSERT INTO notifications (agent_id, thread_id, message_id) VALUES (?, ?, ?)"
    );
    const subsOf = db.prepare(
      "SELECT agent_id FROM subscriptions WHERE thread_id = ? AND agent_id != ?"
    );

    for (const sub of subsOf.all(threadId, agent.id) as { agent_id: number }[]) {
      notify.run(sub.agent_id, threadId, messageId);
    }

    if (linkId !== null && linkId !== threadId) {
      for (const sub of subsOf.all(linkId, agent.id) as { agent_id: number }[]) {
        notify.run(sub.agent_id, threadId, messageId);
      }
    }

    res.json({ message_id: messageId });
  });

  app.get("/threads", (req: Request, res: Response) => {
    const { status, before, limit } = req.query;
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (status === "open" || status === "closed") {
      conditions.push("t.status = ?");
      params.push(status);
    }
    if (before) {
      conditions.push("t.id < ?");
      params.push(Number(before));
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit ? Number(limit) : 50);

    const rows = db
      .prepare(
        `SELECT t.id, t.title, t.status, t.created_by,
                COUNT(m.id) AS message_count, MAX(m.created_at) AS last_activity
         FROM threads t JOIN messages m ON m.thread_id = t.id
         ${where}
         GROUP BY t.id
         ORDER BY t.id DESC
         LIMIT ?`
      )
      .all(...params);

    res.json({ threads: rows });
  });

  app.get("/threads/:id", (req: Request, res: Response) => {
    const threadId = Number(req.params.id);
    const thread = db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
    if (!thread) return res.status(404).json({ error: "unknown thread, check thread id" });

    const before = req.query.before ? Number(req.query.before) : null;
    const rows = before
      ? db
          .prepare(
            "SELECT * FROM messages WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT 50"
          )
          .all(threadId, before)
      : db
          .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 50")
          .all(threadId);

    res.json({ messages: rows.reverse() });
  });

  app.get("/read", (req: Request, res: Response) => {
    const threadId = Number(req.query.thread_id);
    const messageId = Number(req.query.message_id);
    const row = db
      .prepare("SELECT * FROM messages WHERE thread_id = ? AND id = ?")
      .get(threadId, messageId);
    if (!row) return res.status(404).json({ error: "unknown message" });
    res.json(row);
  });

  app.post("/subscribe", (req: Request, res: Response) => {
    const { name, id, thread_id } = req.body ?? {};
    const agent = resolveAgent(name, id);
    if (!agent) return res.status(400).json({ error: "unknown agent" });
    db.prepare("INSERT OR IGNORE INTO subscriptions (thread_id, agent_id) VALUES (?, ?)").run(
      Number(thread_id),
      agent.id
    );
    res.json({ ok: true });
  });

  app.post("/unsubscribe", (req: Request, res: Response) => {
    const { name, id, thread_id } = req.body ?? {};
    const agent = resolveAgent(name, id);
    if (!agent) return res.status(400).json({ error: "unknown agent" });
    db.prepare("DELETE FROM subscriptions WHERE thread_id = ? AND agent_id = ?").run(
      Number(thread_id),
      agent.id
    );
    res.json({ ok: true });
  });

  app.post("/threads/:id/close", (req: Request, res: Response) => {
    const threadId = Number(req.params.id);
    const { name, id } = req.body ?? {};
    const agent = resolveAgent(name, id);
    if (!agent) return res.status(400).json({ error: "unknown agent" });

    const thread = db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
    if (!thread) return res.status(404).json({ error: "unknown thread, check thread id" });

    const participant = db
      .prepare("SELECT 1 FROM subscriptions WHERE thread_id = ? AND agent_id = ?")
      .get(threadId, agent.id);
    if (!participant) return res.status(403).json({ error: "not a participant" });

    db.prepare("UPDATE threads SET status = 'closed' WHERE id = ?").run(threadId);
    res.json({ ok: true });
  });

  // ponytail: no auth — trusted-network-only admin surface, see WEBUI_IMPLEMENTATION_PLAN.md.
  // Upgrade path: ADMIN_TOKEN env var + header check, if ever exposed beyond a trusted network.
  app.post("/admin/threads/:id/close", (req: Request, res: Response) => {
    const threadId = Number(req.params.id);
    const thread = db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
    if (!thread) return res.status(404).json({ error: "unknown thread, check thread id" });
    db.prepare("UPDATE threads SET status = 'closed' WHERE id = ?").run(threadId);
    res.json({ ok: true });
  });

  app.get("/notifications", (req: Request, res: Response) => {
    const agentId = Number(req.query.id);
    const rows = db
      .prepare(
        "SELECT id AS notif_id, thread_id, message_id FROM notifications WHERE agent_id = ? AND acked = 0"
      )
      .all(agentId);
    res.json({ notifications: rows });
  });

  app.post("/ignore-notif", (req: Request, res: Response) => {
    const { id, notif_id } = req.body ?? {};
    const row = db
      .prepare("SELECT id FROM notifications WHERE id = ? AND agent_id = ?")
      .get(Number(notif_id), Number(id));
    if (!row) return res.status(404).json({ error: "unknown notification" });
    db.prepare("UPDATE notifications SET acked = 1 WHERE id = ?").run(Number(notif_id));
    res.json({ ok: true });
  });

  return app;
}

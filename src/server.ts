import express, { Request, Response } from "express";
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { emitOtelLog } from "./otel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function sweepExpiredThreads(
  db: DatabaseSync,
  opts?: { audit?: (fields: Record<string, unknown>) => void; broadcast?: (event: Record<string, unknown>) => void }
) {
  try {
    const now = Date.now();
    const expired = db
      .prepare("SELECT id FROM threads WHERE status='open' AND expires_at IS NOT NULL AND expires_at <= ?")
      .all(now) as { id: number }[];
    if (expired.length === 0) return 0;
    const res = db.prepare("UPDATE threads SET status='closed' WHERE status='open' AND expires_at IS NOT NULL AND expires_at <= ?").run(now);
    if ((res.changes as number) > 0) log({ message: "ttl sweep closed", closed: res.changes });
    if (opts?.audit || opts?.broadcast) {
      for (const row of expired) {
        try { opts.audit?.({ action: "ttl_sweep_close", thread_id: row.id }); } catch {}
        try { opts.broadcast?.({ type: "thread_closed", thread_id: row.id }); } catch {}
      }
    }
    return res.changes as number;
  } catch { return 0; }
}

export function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
  emitOtelLog(fields);
}

// ponytail: single append-only file, not one-per-month — lattice's write
// volume doesn't warrant rotation. Upgrade path: split by date if the file
// gets unwieldy.
export function makeAuditLog(dbPath: string) {
  const auditPath = path.join(path.dirname(dbPath), "audit.jsonl");
  return function audit(fields: Record<string, unknown>) {
    try {
      mkdirSync(path.dirname(auditPath), { recursive: true });
      appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), ...fields }) + "\n");
    } catch (err) {
      log({ level: "error", message: "audit log write failed", error: String(err) });
    }
    emitOtelLog({ message: "audit", ...fields });
  };
}

// ponytail: fixed-window counter, per process, not per cluster node — fine
// for a single-process server. Upgrade path: shared store if ever scaled out.
function rateLimiter(maxPerWindow: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: express.NextFunction) => {
    const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const key = bearer || req.ip || "unknown";
    const now = Date.now();
    if (hits.size > 100) {
      for (const [k, v] of hits) {
        if (v.resetAt <= now) hits.delete(k);
      }
    }
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= maxPerWindow) {
      return res.status(429).json({ error: "too many requests" });
    }
    entry.count++;
    next();
  };
}

export function createServer(db: DatabaseSync, dbPath = process.env.DB_PATH ?? "/data/threads.db") {
  const app = express();
  // Trust proxy when behind a reverse proxy (e.g. Caddy): set TRUST_PROXY=1
  // so req.ip reflects the real client via X-Forwarded-For. Otherwise leave
  // "trust proxy" unset so req.ip stays the real socket address — trusting
  // X-Forwarded-For without an actual proxy would let any client spoof it
  // and bypass rateLimiter().
  if (process.env.TRUST_PROXY) {
    app.set("trust proxy", 1);
  }
  const startedAt = Date.now();
  const adminToken = process.env.ADMIN_TOKEN;
  const audit = makeAuditLog(dbPath);
  app.use(express.json());
  app.use((req: Request, _res: Response, next) => {
    log({ method: req.method, url: req.originalUrl });
    next();
  });
  app.use(express.static(path.join(__dirname, "..", "public")));

  // ponytail: single in-process Set of open SSE responses — this server is
  // single-process per CLAUDE.md, no pub/sub infra needed. Upgrade path: a
  // real broker if this ever runs multi-instance.
  const sseClients = new Set<Response>();
  function broadcast(event: Record<string, unknown>) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      client.write(payload);
    }
  }

  app.get("/events", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    const hb = setInterval(() => { try { res.write(": keepalive\n\n"); } catch {} }, 25000);
    req.on("close", () => {
      clearInterval(hb);
      sseClients.delete(res);
    });
  });

  // ponytail: per-agent SSE fanout, separate from the admin `/events` feed
  // above — that one is untargeted (every connected admin sees everything).
  // This one only ever emits notifications for the one agent that opened it.
  const notifSseClients = new Map<number, Set<Response>>();
  function pushNotification(agentId: number, payload: Record<string, unknown>) {
    const clients = notifSseClients.get(agentId);
    if (!clients) return;
    const message = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      client.write(message);
    }
  }

  function resolveAgent(name: unknown, id: unknown): { id: number } | null {
    if (typeof name !== "string" || (typeof id !== "number" && typeof id !== "string")) return null;
    const row = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(Number(id)) as
      | { id: number; name: string }
      | undefined;
    if (!row || row.name !== name) return null;
    return { id: row.id };
  }

  function resolveAgentByToken(token: string): { id: number; name: string } | null {
    if (!token) return null;
    const row = db.prepare("SELECT id, name FROM agents WHERE token = ?").get(token) as
      | { id: number; name: string }
      | undefined;
    if (!row) return null;
    return { id: row.id, name: row.name };
  }

  const lastTouch = new Map<number, number>();
  function touchAgent(agentId: number) {
    const now = Date.now();
    const last = lastTouch.get(agentId);
    if (last !== undefined && now - last < 30000) return;
    lastTouch.set(agentId, now);
    try {
      db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(now, agentId);
    } catch {}
  }

  function resolveAuth(req: Request): { id: number; name: string } | null {
    const auth = req.header("authorization");
    if (auth) {
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (m) {
        const agent = resolveAgentByToken(m[1].trim());
        if (agent) {
          touchAgent(agent.id);
          return agent;
        }
        return null;
      }
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const q = req.query as Record<string, unknown>;
    const name = (body.name ?? q.name) as unknown;
    const id = (body.id ?? q.id) as unknown;
    const legacy = resolveAgent(name, id);
    if (legacy) {
      const row = db.prepare("SELECT name FROM agents WHERE id = ?").get(legacy.id) as { name: string } | undefined;
      log({ level: "warn", message: "deprecated auth: name+id without Bearer token", agent_id: legacy.id });
      touchAgent(legacy.id);
      return { id: legacy.id, name: row?.name ?? String(name) };
    }
    return null;
  }

  function roleCatalogSize(): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM roles").get() as { c: number }).c;
  }

  function roleExists(role: string): boolean {
    return !!db.prepare("SELECT 1 FROM roles WHERE name = ?").get(role);
  }

  function sweepExpired() { sweepExpiredThreads(db, { audit, broadcast }); }
  try { sweepExpired(); } catch {}
  const sweepInterval = setInterval(sweepExpired, 5 * 60 * 1000);
  // allow process to exit in tests even if server not closed
  if (typeof (sweepInterval as unknown as { unref?: () => void }).unref === "function") {
    (sweepInterval as unknown as { unref: () => void }).unref();
  }

  app.post("/register", rateLimiter(30, 60_000), (req: Request, res: Response) => {
    const { name, secret, role } = req.body ?? {};
    if (typeof name !== "string" || !name) return res.status(400).json({ error: "name required" });
    if (role !== undefined && typeof role !== "string") {
      return res.status(400).json({ error: "role must be a string" });
    }
    // ponytail: catalog starts empty on a fresh server, so the first agents
    // (e.g. whoever seeds the roles via POST /roles) must be able to
    // register before any role exists. Once the catalog is seeded,
    // registering/re-registering with a role requires picking from it.
    const catalogSeeded = roleCatalogSize() > 0;
    if (catalogSeeded) {
      if (!role) return res.status(400).json({ error: "role required, see GET /roles" });
      if (!roleExists(role)) return res.status(400).json({ error: "unknown role, see GET /roles" });
    }

    const existing = db.prepare("SELECT id, secret, token FROM agents WHERE name = ?").get(name) as
      | { id: number; secret: string; token: string | null }
      | undefined;

    if (existing) {
      if (secret && secret === existing.secret) {
        if (typeof role === "string") {
          db.prepare("UPDATE agents SET role = ? WHERE id = ?").run(role, existing.id);
        }
        let token = existing.token;
        if (!token) {
          token = crypto.randomBytes(16).toString("hex");
          db.prepare("UPDATE agents SET token = ? WHERE id = ?").run(token, existing.id);
        }
        return res.json({ id: existing.id, secret: existing.secret, token });
      }
      // Include the id so a client that lost its secret can reconstruct a
      // usable identity: the write path authenticates on name+id only
      // (cooperative model), so id recovery unblocks every command except
      // rotate-secret. Reported in #16.
      return res.status(409).json({ error: "name taken", id: existing.id });
    }

    const newSecret = crypto.randomBytes(16).toString("hex");
    const newToken = crypto.randomBytes(16).toString("hex");
    let result;
    try {
      result = db
        .prepare("INSERT INTO agents (name, secret, token, role) VALUES (?, ?, ?, ?)")
        .run(name, newSecret, newToken, typeof role === "string" ? role : null);
    } catch (err: any) {
      if (String(err?.message).includes("UNIQUE constraint failed")) {
        const row = db.prepare("SELECT id FROM agents WHERE name = ?").get(name) as
          | { id: number }
          | undefined;
        return res.status(409).json({ error: "name taken", id: row?.id });
      }
      throw err;
    }
    audit({ action: "register", agent_id: Number(result.lastInsertRowid), name, role: role ?? null });
    broadcast({ type: "agent_registered", agent_id: Number(result.lastInsertRowid) });
    res.json({ id: Number(result.lastInsertRowid), secret: newSecret, token: newToken });
  });

  app.get("/agents", (_req: Request, res: Response) => {
    const rows = db.prepare("SELECT id, name, role, status, last_seen FROM agents").all() as { id: number; name: string; role: string | null; status: string | null; last_seen: number | null }[];
    const now = Date.now();
    const agents = rows.map((r) => {
      let presence: string;
      if (!r.last_seen) presence = "stale";
      else {
        const age = now - r.last_seen;
        if (age < 120_000) presence = "active";
        else if (age < 600_000) presence = "idle";
        else presence = "stale";
      }
      return { ...r, presence };
    });
    res.json({ agents });
  });

  // 120/min per IP: a busy multi-agent run (several agents posting status
  // updates, replies, and acks) legitimately bursts past 30/min — the old
  // budget made the integration suite itself trip the limiter. Still caps
  // floods at 2 writes/sec sustained.
  const writeLimiter = rateLimiter(120, 60_000);

  app.post("/agents/status", writeLimiter, (req: Request, res: Response) => {
    const agent = resolveAuth(req);
    if (!agent) return res.status(401).json({ error: "unauthorized" });
    const { status } = req.body ?? {};
    if (status !== null && typeof status !== "string") {
      return res.status(400).json({ error: "status must be a string or null" });
    }
    db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, agent.id);
    audit({ action: "set_status", agent_id: agent.id, status });
    broadcast({ type: "agent_status", agent_id: agent.id });
    res.json({ ok: true });
  });

  app.post("/roles", (req: Request, res: Response) => {
    const agent = resolveAuth(req);
    if (!agent) return res.status(401).json({ error: "unauthorized" });
    const { role } = req.body ?? {};
    if (typeof role !== "string" || !role) return res.status(400).json({ error: "role required" });

    db.prepare("INSERT OR IGNORE INTO roles (name, created_by, created_at) VALUES (?, ?, ?)").run(
      role,
      agent.id,
      Date.now()
    );
    audit({ action: "add_role", agent_id: agent.id, role });
    res.json({ ok: true });
  });

  app.get("/roles", (_req: Request, res: Response) => {
    const rows = db.prepare("SELECT name, created_by, created_at FROM roles ORDER BY name").all();
    res.json({ roles: rows });
  });

  app.post("/threads", writeLimiter, (req: Request, res: Response) => {
    const agent = resolveAuth(req);
    if (!agent) return res.status(401).json({ error: "unauthorized" });
    const { title, body, wants_role, expires_at } = req.body ?? {};
    if (typeof title !== "string" || typeof body !== "string") {
      return res.status(400).json({ error: "title and body required" });
    }
    if (wants_role !== undefined && wants_role !== null && typeof wants_role !== "string") {
      return res.status(400).json({ error: "wants_role must be a string" });
    }
    // Same rule as /register: only enforce membership once the catalog is seeded.
    if (typeof wants_role === "string" && roleCatalogSize() > 0 && !roleExists(wants_role)) {
      return res.status(400).json({ error: "unknown role, see GET /roles" });
    }
    let expiresAt: number | null = null;
    if (expires_at !== undefined && expires_at !== null) {
      if (typeof expires_at === "number") expiresAt = expires_at;
      else if (typeof expires_at === "string") {
        const parsed = Date.parse(expires_at);
        if (Number.isNaN(parsed)) return res.status(400).json({ error: "invalid expires_at" });
        expiresAt = parsed;
      } else {
        return res.status(400).json({ error: "invalid expires_at" });
      }
      if (expiresAt <= Date.now()) return res.status(400).json({ error: "expires_at must be in the future" });
    }

    const threadResult = db
      .prepare("INSERT INTO threads (title, created_by, wants_role, expires_at) VALUES (?, ?, ?, ?)")
      .run(title, agent.id, typeof wants_role === "string" ? wants_role : null, expiresAt);
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

    audit({ action: "create_thread", agent_id: agent.id, thread_id: threadId, message_id: Number(msgResult.lastInsertRowid) });
    broadcast({ type: "thread_created", thread_id: threadId });
    broadcast({ type: "message", thread_id: threadId });
    res.json({ thread_id: threadId, message_id: Number(msgResult.lastInsertRowid) });
  });

  app.post("/threads/:id/reply", writeLimiter, (req: Request, res: Response) => {
    const threadId = Number(req.params.id);
    if (!Number.isInteger(threadId)) return res.status(400).json({ error: "invalid thread id" });
    const agent = resolveAuth(req);
    if (!agent) return res.status(401).json({ error: "unauthorized" });
    const { body, link_thread_id } = req.body ?? {};
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
      const notifId = Number(notify.run(sub.agent_id, threadId, messageId).lastInsertRowid);
      pushNotification(sub.agent_id, { notif_id: notifId, thread_id: threadId, message_id: messageId });
    }

    if (linkId !== null && linkId !== threadId) {
      for (const sub of subsOf.all(linkId, agent.id) as { agent_id: number }[]) {
        const notifId = Number(notify.run(sub.agent_id, threadId, messageId).lastInsertRowid);
        pushNotification(sub.agent_id, { notif_id: notifId, thread_id: threadId, message_id: messageId });
      }
    }

    audit({ action: "reply", agent_id: agent.id, thread_id: threadId, message_id: messageId, link_thread_id: linkId });
    broadcast({ type: "message", thread_id: threadId });
    res.json({ message_id: messageId });
  });

  app.get("/threads", (req: Request, res: Response) => {
    const { status, before, limit, title, claimed, role } = req.query;
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
    if (typeof title === "string" && title) {
      conditions.push("t.title LIKE ? ESCAPE '\\'");
      params.push(`%${title.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (claimed === "true") {
      conditions.push("t.claimed_by IS NOT NULL");
    } else if (claimed === "false") {
      conditions.push("t.claimed_by IS NULL");
    }
    if (typeof role === "string" && role) {
      conditions.push("t.wants_role = ?");
      params.push(role);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitNum = limit ? Number(limit) : 50;
    params.push(Number.isInteger(limitNum) && limitNum > 0 ? Math.min(limitNum, 200) : 50);

    const rows = db
      .prepare(
        `SELECT t.id, t.title, t.status, t.created_by, t.claimed_by, t.wants_role,
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
    if (!Number.isInteger(threadId)) return res.status(400).json({ error: "invalid thread id" });
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
    if (!Number.isInteger(threadId) || !Number.isInteger(messageId)) {
      return res.status(400).json({ error: "invalid thread_id or message_id" });
    }
    const row = db
      .prepare("SELECT * FROM messages WHERE thread_id = ? AND id = ?")
      .get(threadId, messageId);
    if (!row) return res.status(404).json({ error: "unknown message" });
    res.json(row);
  });

  app.post("/subscribe", writeLimiter, (req: Request, res: Response) => {
    const agent = resolveAuth(req);
    if (!agent) return res.status(401).json({ error: "unauthorized" });
    const { thread_id } = req.body ?? {};
    const thread = db.prepare("SELECT id FROM threads WHERE id = ?").get(Number(thread_id));
    if (!thread) return res.status(404).json({ error: "unknown thread, check thread id" });
    db.prepare("INSERT OR IGNORE INTO subscriptions (thread_id, agent_id) VALUES (?, ?)").run(
      Number(thread_id),
      agent.id
    );
    audit({ action: "subscribe", agent_id: agent.id, thread_id: Number(thread_id) });
    res.json({ ok: true });
  });

  app.post("/unsubscribe", writeLimiter, (req: Request, res: Response) => {
    const agent = resolveAuth(req);
    if (!agent) return res.status(401).json({ error: "unauthorized" });
    const { thread_id } = req.body ?? {};
    const thread = db.prepare("SELECT id FROM threads WHERE id = ?").get(Number(thread_id));
    if (!thread) return res.status(404).json({ error: "unknown thread, check thread id" });
    db.prepare("DELETE FROM subscriptions WHERE thread_id = ? AND agent_id = ?").run(
      Number(thread_id),
      agent.id
    );
    audit({ action: "unsubscribe", agent_id: agent.id, thread_id: Number(thread_id) });
    res.json({ ok: true });
  });

  app.post("/threads/:id/close", (req: Request, res: Response) => {
    const threadId = Number(req.params.id);
    if (!Number.isInteger(threadId)) return res.status(400).json({ error: "invalid thread id" });
    const agent = resolveAuth(req);
    if (!agent) return res.status(401).json({ error: "unauthorized" });

    const thread = db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
    if (!thread) return res.status(404).json({ error: "unknown thread, check thread id" });

    const participant = db
      .prepare("SELECT 1 FROM subscriptions WHERE thread_id = ? AND agent_id = ?")
      .get(threadId, agent.id);
    if (!participant) return res.status(403).json({ error: "not a participant" });

    db.prepare("UPDATE threads SET status = 'closed' WHERE id = ?").run(threadId);
    audit({ action: "close_thread", agent_id: agent.id, thread_id: threadId });
    broadcast({ type: "thread_closed", thread_id: threadId });
    res.json({ ok: true });
  });

  app.post("/threads/:id/claim", writeLimiter, (req: Request, res: Response) => {
    const threadId = Number(req.params.id);
    if (!Number.isInteger(threadId)) return res.status(400).json({ error: "invalid thread id" });
    const agent = resolveAuth(req);
    if (!agent) return res.status(401).json({ error: "unauthorized" });

    const thread = db.prepare("SELECT id, claimed_by FROM threads WHERE id = ?").get(threadId) as
      | { id: number; claimed_by: number | null }
      | undefined;
    if (!thread) return res.status(404).json({ error: "unknown thread, check thread id" });

    const result = db
      .prepare("UPDATE threads SET claimed_by = ? WHERE id = ? AND claimed_by IS NULL")
      .run(agent.id, threadId);
    if ((result.changes as number) === 0) {
      return res.status(409).json({ error: "already claimed", claimed_by: thread.claimed_by });
    }

    db.prepare("INSERT OR IGNORE INTO subscriptions (thread_id, agent_id) VALUES (?, ?)").run(
      threadId,
      agent.id
    );
    audit({ action: "claim_thread", agent_id: agent.id, thread_id: threadId });
    broadcast({ type: "thread_claimed", thread_id: threadId });
    res.json({ ok: true });
  });

  app.post("/threads/:id/unclaim", writeLimiter, (req: Request, res: Response) => {
    const threadId = Number(req.params.id);
    if (!Number.isInteger(threadId)) return res.status(400).json({ error: "invalid thread id" });
    const agent = resolveAuth(req);
    if (!agent) return res.status(401).json({ error: "unauthorized" });

    const thread = db.prepare("SELECT claimed_by FROM threads WHERE id = ?").get(threadId) as
      | { claimed_by: number | null }
      | undefined;
    if (!thread) return res.status(404).json({ error: "unknown thread, check thread id" });
    if (thread.claimed_by !== agent.id) return res.status(403).json({ error: "not the claimant" });

    db.prepare("UPDATE threads SET claimed_by = NULL WHERE id = ?").run(threadId);
    audit({ action: "unclaim_thread", agent_id: agent.id, thread_id: threadId });
    broadcast({ type: "thread_unclaimed", thread_id: threadId });
    res.json({ ok: true });
  });

  app.post("/admin/threads/:id/close", (req: Request, res: Response) => {
    if (adminToken) {
      if (req.header("authorization") !== `Bearer ${adminToken}`) {
        return res.status(401).json({ error: "unauthorized" });
      }
    } else {
      const ip = req.ip || "";
      const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
      if (!loopback) return res.status(401).json({ error: "admin not configured, loopback only" });
    }
    const threadId = Number(req.params.id);
    if (!Number.isInteger(threadId)) return res.status(400).json({ error: "invalid thread id" });
    const thread = db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
    if (!thread) return res.status(404).json({ error: "unknown thread, check thread id" });
    db.prepare("UPDATE threads SET status = 'closed' WHERE id = ?").run(threadId);
    audit({ action: "admin_close_thread", thread_id: threadId });
    broadcast({ type: "thread_closed", thread_id: threadId });
    res.json({ ok: true });
  });

  app.get("/notifications/stream", (req: Request, res: Response) => {
    let agent = resolveAuth(req);
    // resolveAuth checks body/query legacy; for stream the query carries name+id
    if (!agent) return res.status(401).json({ error: "unauthorized" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    let clients = notifSseClients.get(agent.id);
    if (!clients) {
      clients = new Set();
      notifSseClients.set(agent.id, clients);
    }
    clients.add(res);
    const hb = setInterval(() => { try { res.write(": keepalive\n\n"); } catch {} }, 25000);
    req.on("close", () => {
      clearInterval(hb);
      clients!.delete(res);
      if (clients!.size === 0) notifSseClients.delete(agent.id);
    });
  });

  app.get("/notifications", (req: Request, res: Response) => {
    const auth = resolveAuth(req);
    if (!auth) return res.status(401).json({ error: "unauthorized" });
    const agentId = auth.id;
    const before = req.query.before ? Number(req.query.before) : null;
    if (before !== null && !Number.isInteger(before)) return res.status(400).json({ error: "invalid before" });
    const rows = before
      ? db
          .prepare(
            "SELECT id AS notif_id, thread_id, message_id FROM notifications WHERE agent_id = ? AND id < ? ORDER BY id DESC LIMIT 50"
          )
          .all(agentId, before)
      : db
          .prepare(
            "SELECT id AS notif_id, thread_id, message_id FROM notifications WHERE agent_id = ? ORDER BY id DESC LIMIT 50"
          )
          .all(agentId);
    res.json({ notifications: rows.reverse() });
  });

  app.get("/notifications/count", (req: Request, res: Response) => {
    const auth = resolveAuth(req);
    if (!auth) return res.status(401).json({ error: "unauthorized" });
    const agentId = auth.id;
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM notifications WHERE agent_id = ?")
      .get(agentId) as { count: number };
    res.json({ count: row.count });
  });

  app.post("/ignore-notif", writeLimiter, (req: Request, res: Response) => {
    const agent = resolveAuth(req);
    if (!agent) return res.status(401).json({ error: "unauthorized" });
    const { notif_id } = req.body ?? {};
    const row = db
      .prepare("SELECT id FROM notifications WHERE id = ? AND agent_id = ?")
      .get(Number(notif_id), agent.id);
    if (!row) return res.status(404).json({ error: "unknown notification" });
    db.prepare("DELETE FROM notifications WHERE id = ?").run(Number(notif_id));
    res.json({ ok: true });
  });

  app.post("/ignore-notif/batch", writeLimiter, (req: Request, res: Response) => {
    const agent = resolveAuth(req);
    if (!agent) return res.status(401).json({ error: "unauthorized" });
    const { notif_ids } = req.body ?? {};
    if (!Array.isArray(notif_ids)) return res.status(400).json({ error: "notif_ids required" });
    const ack = db.prepare("DELETE FROM notifications WHERE id = ? AND agent_id = ?");
    let acked = 0;
    for (const notifId of notif_ids) {
      acked += ack.run(Number(notifId), agent.id).changes as number;
    }
    res.json({ acked });
  });

  app.post("/agents/rotate-secret", (req: Request, res: Response) => {
    const { name, id, secret } = req.body ?? {};
    const row = db.prepare("SELECT id, secret FROM agents WHERE id = ?").get(Number(id)) as
      | { id: number; secret: string }
      | undefined;
    if (!row) return res.status(404).json({ error: "unknown agent" });
    const nameRow = db.prepare("SELECT name FROM agents WHERE id = ?").get(row.id) as { name: string };
    if (nameRow.name !== name || row.secret !== secret) {
      return res.status(403).json({ error: "invalid secret" });
    }
    const newSecret = crypto.randomBytes(16).toString("hex");
    db.prepare("UPDATE agents SET secret = ? WHERE id = ?").run(newSecret, row.id);
    audit({ action: "rotate_secret", agent_id: row.id });
    res.json({ secret: newSecret });
  });

  app.get("/health", (_req: Request, res: Response) => {
    const threads = (db.prepare("SELECT COUNT(*) AS c FROM threads").get() as { c: number }).c;
    const messages = (db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
    const agents = (db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c;
    res.json({
      status: "ok",
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      db_path: dbPath,
      threads,
      messages,
      agents,
    });
  });

  // ponytail: last-resort JSON error handler — malformed body or an
  // unexpected DB error becomes a 400/500 JSON response instead of
  // Express's default HTML page. Express 4 auto-forwards sync throws here.
  app.use((err: any, _req: Request, res: Response, _next: express.NextFunction) => {
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "malformed JSON body" });
    }
    log({ level: "error", message: err?.message ?? String(err), stack: err?.stack });
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

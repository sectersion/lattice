import { DatabaseSync } from "node:sqlite";

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      secret TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
      created_by INTEGER NOT NULL REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES threads(id),
      author_id INTEGER NOT NULL REFERENCES agents(id),
      body TEXT NOT NULL,
      link_thread_id INTEGER REFERENCES threads(id),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      thread_id INTEGER NOT NULL REFERENCES threads(id),
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      PRIMARY KEY (thread_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      thread_id INTEGER NOT NULL REFERENCES threads(id),
      message_id INTEGER NOT NULL REFERENCES messages(id),
      acked INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_agent_acked ON notifications(agent_id, acked);
  `);
  return db;
}

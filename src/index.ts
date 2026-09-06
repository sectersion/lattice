import { openDb } from "./db.js";
import { createServer, log } from "./server.js";
import { initOtel } from "./otel.js";
import { backupDb } from "./backup.js";

initOtel();

const dbPath = process.env.DB_PATH ?? "/data/threads.db";
const port = Number(process.env.PORT ?? 3000);

const db = openDb(dbPath);
const app = createServer(db, dbPath);

const server = app.listen(port, () => {
  log({ message: "listening", port, dbPath });
});

// daily WAL-safe backup via VACUUM INTO (see src/backup.ts)
function scheduleDailyBackup() {
  const doBackup = () => {
    try {
      backupDb(db, dbPath);
    } catch (err) {
      log({ level: "error", message: "backup failed", error: String(err) });
    }
  };
  // every 24h
  const iv = setInterval(doBackup, 24 * 60 * 60 * 1000);
  if (typeof (iv as unknown as { unref?: () => unknown }).unref === "function") (iv as unknown as { unref: () => void }).unref();
  // also fire at next 02:00 UTC, then daily cadence covers it after
  const now = new Date();
  const next02 = new Date(now);
  next02.setUTCHours(2, 0, 0, 0);
  if (next02 <= now) next02.setUTCDate(next02.getUTCDate() + 1);
  const to = setTimeout(doBackup, next02.getTime() - now.getTime());
  if (typeof (to as unknown as { unref?: () => unknown }).unref === "function") (to as unknown as { unref: () => void }).unref();
}
scheduleDailyBackup();

function shutdown() {
  log({ message: "shutting down" });
  server.close(() => {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      log({ message: "wal checkpoint complete" });
    } catch (err) {
      log({ level: "warn", message: "wal checkpoint failed", error: String(err) });
    }
    db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

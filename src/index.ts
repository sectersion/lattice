import { openDb } from "./db.js";
import { createServer, log } from "./server.js";
import { initOtel } from "./otel.js";

initOtel();

const dbPath = process.env.DB_PATH ?? "/data/threads.db";
const port = Number(process.env.PORT ?? 3000);

const db = openDb(dbPath);
const app = createServer(db, dbPath);

const server = app.listen(port, () => {
  log({ message: "listening", port, dbPath });
});

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

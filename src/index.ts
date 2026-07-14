import { openDb } from "./db.js";
import { createServer } from "./server.js";

const dbPath = process.env.DB_PATH ?? "/data/threads.db";
const port = Number(process.env.PORT ?? 3000);

const db = openDb(dbPath);
const app = createServer(db, dbPath);

const server = app.listen(port, () => {
  console.log(`agent-threads listening on :${port} (db: ${dbPath})`);
});

function shutdown() {
  console.log("shutting down");
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

import { openDb } from "./db.js";
import { createServer } from "./server.js";

const dbPath = process.env.DB_PATH ?? "/data/threads.db";
const port = Number(process.env.PORT ?? 3000);

const db = openDb(dbPath);
const app = createServer(db);

app.listen(port, () => {
  console.log(`agent-threads listening on :${port} (db: ${dbPath})`);
});

import { mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { log } from "./server.js";

export function backupDb(db: DatabaseSync, dbPath: string) {
  const backupDir = process.env.LATTICE_BACKUP_DIR || path.join(path.dirname(dbPath), "backups");
  mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 10);
  const dest = path.join(backupDir, `lattice-${ts}.db`);
  try { unlinkSync(dest); } catch {}
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  log({ message: "backup complete", dest });
}

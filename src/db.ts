/**
 * The server's database: <out>/minutes.db, node:sqlite (built into Node 24,
 * so still no runtime deps beyond playwright).
 *
 * One writer, the server process. Capture children never open it; they
 * keep writing only their own manifest.json. WAL mode so readers (backups,
 * a sqlite3 shell) don't block the server.
 *
 * Migrations are numbered by position in MIGRATIONS and tracked in
 * PRAGMA user_version. Append only: never edit or reorder a shipped one.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { logger } from "./util.js";

const log = logger("db");

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  // 1: capture jobs (was jobs.json).
  `CREATE TABLE jobs (
     id          TEXT PRIMARY KEY,
     link        TEXT NOT NULL,
     start       TEXT NOT NULL,          -- ISO UTC
     slug        TEXT NOT NULL,
     name        TEXT NOT NULL,
     email       TEXT,                   -- never sent to the browser
     status      TEXT NOT NULL,
     created_at  TEXT NOT NULL,
     launched_at TEXT,
     ended_at    TEXT,
     exit_code   INTEGER,
     outcome     TEXT,
     error       TEXT
   );
   CREATE INDEX jobs_status ON jobs (status);
   CREATE INDEX jobs_slug ON jobs (slug);`,
];

export function openDb(file: string): DB {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const have = row.user_version;
  if (have > MIGRATIONS.length) {
    throw new Error(`minutes.db is at schema ${have}, newer than this build knows (${MIGRATIONS.length}); refusing to run an older build on it`);
  }
  for (let v = have; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
    log.info(`database migrated to schema ${v + 1}`);
  }
}

/** Run fn in a transaction; rolls back if it throws. Not reentrant. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
